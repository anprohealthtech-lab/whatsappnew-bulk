import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

export class PersistentFileService {
  private uploadDir: string;

  constructor() {
    // Use environment variable for upload directory (for deployment persistence)
    this.uploadDir = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
    this.ensureUploadDirectory();
  }

  private async ensureUploadDirectory(): Promise<void> {
    try {
      await fs.access(this.uploadDir);
    } catch {
      await fs.mkdir(this.uploadDir, { recursive: true });
    }
  }

  async saveFile(file: { originalname: string; size: number; mimetype: string; buffer: Buffer }): Promise<{ fileUrl: string; fileName: string; filePath: string; fileSize: number }> {
    await this.ensureUploadDirectory();

    const fileExtension = path.extname(file.originalname || '');
    const fileName = `${randomUUID()}${fileExtension}`;
    const filePath = path.join(this.uploadDir, fileName);

    await fs.writeFile(filePath, file.buffer);

    return {
      fileUrl: `/uploads/${fileName}`,
      fileName,
      filePath,
      fileSize: file.size
    };
  }

  async deleteFile(fileName: string): Promise<void> {
    const filePath = path.join(this.uploadDir, fileName);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      console.warn(`Failed to delete file ${fileName}:`, error);
    }
  }

  async getFileStats(fileName: string): Promise<{ exists: boolean; size?: number }> {
    const filePath = path.join(this.uploadDir, fileName);
    try {
      const stats = await fs.stat(filePath);
      return { exists: true, size: stats.size };
    } catch {
      return { exists: false };
    }
  }

  getUploadDirectory(): string {
    return this.uploadDir;
  }
}

export const persistentFileService = new PersistentFileService();
