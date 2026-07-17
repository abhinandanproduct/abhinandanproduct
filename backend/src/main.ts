import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
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
  await app.listen(port);
  logger.log(`API running on http://localhost:${port}/api`);
}

bootstrap();
