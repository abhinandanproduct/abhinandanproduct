import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join, resolve } from 'path';
import { promises as fs } from 'fs';
import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { TransformInterceptor } from './common/transform.interceptor';

/**
 * First-boot bootstrap — creates a default admin (admin / admin123) if the
 * users table is completely empty. Solves the chicken-and-egg problem on a
 * fresh DB where no one can create users because user-creation is protected
 * by @Roles('ADMIN'). Runs once on every start but is idempotent — if any
 * user exists (even a demo one), it's a no-op.
 *
 * Log in with these creds, immediately go to Admin → Users to create your
 * real users, then delete this default admin.
 */
async function seedInitialAdmin(logger: Logger) {
  const prisma = new PrismaClient();
  try {
    const userCount = await prisma.user.count();
    if (userCount > 0) return;
    const passwordHash = await bcrypt.hash('admin123', 10);
    await prisma.user.create({
      data: {
        username: 'admin',
        fullName: 'System Administrator',
        email: 'admin@abhinandan.local',
        passwordHash,
        role: UserRole.ADMIN,
      },
    });
    logger.warn('First-boot admin created: username=admin, password=admin123 — CHANGE THIS IMMEDIATELY via Admin → Users.');
  } catch (e) {
    logger.error('Initial admin seed failed', e as any);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * First-boot uploads seed — if the runtime uploads directory is empty
 * (fresh volume, or first deploy) AND a `uploads_seed/` sibling exists
 * in the repo, copy every file over. Idempotent: as soon as the runtime
 * dir has any content, this becomes a no-op, so it won't clobber
 * anything users upload later.
 *
 * Necessary because Railway containers are ephemeral by default —
 * uploaded files vanish on redeploy. We attach a persistent volume,
 * then use this seed to get the legacy files onto that volume once.
 * After a few successful deploys the `uploads_seed/` folder can be
 * deleted from the repo to reclaim git space.
 */
async function seedUploadsIfEmpty(logger: Logger) {
  const uploadDir = process.env.UPLOAD_DIR ?? 'uploads';
  const runtime = resolve(process.cwd(), uploadDir);
  // Seed lives next to the compiled backend at `<repo>/backend/uploads_seed`
  // regardless of where the process runs from — search a couple of likely
  // parents.
  const candidates = [
    resolve(process.cwd(), 'uploads_seed'),
    resolve(process.cwd(), 'backend', 'uploads_seed'),
    resolve(process.cwd(), '..', 'uploads_seed'),
  ];
  let seed = '';
  for (const c of candidates) {
    try {
      const s = await fs.stat(c);
      if (s.isDirectory()) { seed = c; break; }
    } catch {}
  }
  if (!seed) return;

  await fs.mkdir(runtime, { recursive: true });
  const existing = await fs.readdir(runtime);
  if (existing.length > 0) return;

  let count = 0;
  async function copyDir(from: string, to: string) {
    await fs.mkdir(to, { recursive: true });
    const entries = await fs.readdir(from, { withFileTypes: true });
    for (const e of entries) {
      const src = join(from, e.name);
      const dst = join(to, e.name);
      if (e.isDirectory()) await copyDir(src, dst);
      else { await fs.copyFile(src, dst); count++; }
    }
  }
  try {
    await copyDir(seed, runtime);
    logger.warn(`Seeded ${count} uploaded file(s) from ${seed} → ${runtime}`);
  } catch (e) {
    logger.error('Uploads seed failed', e as any);
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  // Allow the configured origins, plus any localhost / 127.0.0.1 port during
  // development (covers http://127.0.0.1:3000, Next.js falling back to :3001, etc.).
  // `*` as a value is treated as a true wildcard — echo the request's origin
  // back so it works with `credentials: true` (browsers reject a literal `*`
  // when credentials are involved).
  const configured = (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const wildcard = configured.includes('*');
  const localhostPattern = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.enableCors({
    origin: (origin, callback) => {
      // Non-browser clients (curl, server-to-server) send no Origin → allow.
      if (!origin) return callback(null, true);
      if (wildcard || configured.includes(origin) || localhostPattern.test(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
  });

  // Serve uploaded files statically at /uploads
  const uploadDir = process.env.UPLOAD_DIR ?? 'uploads';
  app.useStaticAssets(join(process.cwd(), uploadDir), { prefix: '/uploads/' });

  const port = Number(process.env.PORT ?? 4000);
  const logger = new Logger('Bootstrap');
  await seedInitialAdmin(logger);
  await seedUploadsIfEmpty(logger);
  await app.listen(port);
  logger.log(`API running on http://localhost:${port}/api`);
}

bootstrap();
