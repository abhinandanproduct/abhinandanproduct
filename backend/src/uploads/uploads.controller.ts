import {
  BadRequestException,
  Controller,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UploadsService } from './uploads.service';
import { CurrentUser, AuthUser } from '../common/decorators';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB ?? 5)) * 1024 * 1024 },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Query('module') module = 'misc',
    @Query('type') type: 'image' | 'cad' = 'image',
    @CurrentUser() user?: AuthUser,
  ) {
    if (!file) throw new BadRequestException('No file uploaded.');
    return this.uploads.save(file, module, type === 'cad' ? 'cad' : 'image', user?.id);
  }
}
