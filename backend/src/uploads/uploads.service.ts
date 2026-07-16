import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { extname, join } from 'path';
import { PrismaService } from '../prisma/prisma.service';

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const CAD_EXT = ['.stl', '.obj', '.3dm', '.zip', '.pdf', '.jpg', '.jpeg', '.png'];

@Injectable()
export class UploadsService {
  constructor(private prisma: PrismaService) {}

  private uploadDir = process.env.UPLOAD_DIR ?? 'uploads';
  private maxBytes = (Number(process.env.MAX_UPLOAD_MB ?? 5)) * 1024 * 1024;

  async save(
    file: Express.Multer.File,
    module: string,
    kind: 'image' | 'cad',
    userId?: number,
  ) {
    if (!file) throw new BadRequestException('No file uploaded.');
    if (file.size > this.maxBytes) {
      throw new BadRequestException(
        `File exceeds the ${this.maxBytes / 1048576} MB limit.`,
      );
    }

    const safeModule = module.replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'misc';
    const ext = extname(file.originalname).toLowerCase();
    const allowed = kind === 'cad' ? CAD_EXT : IMAGE_EXT;
    if (!allowed.includes(ext)) {
      throw new BadRequestException(`File type ${ext} is not allowed.`);
    }
    if (kind === 'image' && !IMAGE_MIME.includes(file.mimetype)) {
      throw new BadRequestException('File is not a valid image.');
    }

    const dir = join(process.cwd(), this.uploadDir, safeModule);
    await fs.mkdir(dir, { recursive: true });

    const fileName = `${randomBytes(8).toString('hex')}_${Date.now()}${ext}`;
    await fs.writeFile(join(dir, fileName), file.buffer);

    const relativePath = `${safeModule}/${fileName}`;

    await this.prisma.fileAsset.create({
      data: {
        module: safeModule,
        fileType: kind,
        originalName: file.originalname,
        fileName,
        filePath: relativePath,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        uploadedById: userId ?? null,
      },
    });

    return { path: relativePath, url: `/uploads/${relativePath}` };
  }
}
