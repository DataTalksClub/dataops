import fs from 'fs';
import path from 'path';

/**
 * Get the configured upload directory.
 * Uses UPLOAD_DIR environment variable, defaults to ./uploads
 */
function getUploadDir(): string {
  return process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
}

/**
 * Save a file to the local filesystem.
 * Creates directories as needed.
 * Returns the relative storage path: {taskId}/{filename}
 */
function saveFile(taskId: string, filename: string, data: Buffer): string {
  const uploadDir = getUploadDir();
  const dir = path.join(uploadDir, taskId);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, data);

  return path.join(taskId, filename);
}

/**
 * Read a file from the local filesystem.
 * storagePath is relative to the upload directory.
 * Returns the file content as a Buffer.
 */
function readFile(storagePath: string): Buffer {
  const uploadDir = getUploadDir();
  const filePath = path.join(uploadDir, storagePath);
  return fs.readFileSync(filePath);
}

/**
 * Remove a file from the local filesystem.
 * storagePath is relative to the upload directory.
 */
function removeFile(storagePath: string): void {
  const uploadDir = getUploadDir();
  const filePath = path.join(uploadDir, storagePath);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export {
  getUploadDir,
  saveFile,
  readFile,
  removeFile,
};
