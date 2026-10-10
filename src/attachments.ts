import { openSync, readFileSync, fstatSync, closeSync, constants } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { record } from './errors.ts';
import { crc32 } from './crc32.ts';

// SDK0.6.15 PromptInput -> installed ZCode0.16.9 V4 protocol attachments.
export type NativeAttachment = { kind: 'image' | 'file'; filename: string; mimeType: string; sizeBytes: number; localPath?: string; dataBase64?: string };
export type NativeAttachmentRef = { ref: string; fileName: string; mime: string; bytes: number };
// V4 command.ts/attachment-ref.ts, transport.ts:832–960, CLI0.16.9.
export async function createAttachmentRefs(attachments: readonly NativeAttachment[], sessionId: string,
  request: (method: string, params: unknown) => Promise<unknown>): Promise<NativeAttachmentRef[]> {
  const refs: NativeAttachmentRef[] = [];
  for (const attachment of attachments) {
    let ref = attachment.localPath;
    if (!ref) {
      const bytes = Buffer.from(attachment.dataBase64!, 'base64'), chunkSize = 512 * 1024;
      const binding = { connectionId: 'bb-zcode', sessionId, uploadId: randomUUID() };
      try {
        const begin = record(await request('v4/attachment/begin', { ...binding, fileName: attachment.filename, mime: attachment.mimeType,
          totalBytes: bytes.length, totalChunks: Math.ceil(bytes.length / chunkSize), checksum: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }));
        if (begin.uploadId !== binding.uploadId || begin.state !== 'staging' || begin.nextChunkIndex !== 0) throw new Error('Native attachment begin unconfirmed');
        for (let offset = 0, chunkIndex = 0; offset < bytes.length; offset += chunkSize, chunkIndex++) {
          const chunk = record(await request('v4/attachment/chunk', { ...binding, chunkIndex, dataBase64: bytes.subarray(offset, offset + chunkSize).toString('base64') }));
          if (chunk.uploadId !== binding.uploadId || chunk.nextChunkIndex !== chunkIndex + 1) throw new Error('Native attachment chunk unconfirmed');
        }
        const committed = record(await request('v4/attachment/commit', binding));
        if (typeof committed.ref !== 'string' || !committed.ref.startsWith('zcode-artifact://')) throw new Error('Native attachment commit unconfirmed');
        ref = committed.ref;
      } catch (error) {
        try { await request('v4/attachment/abort', binding); } catch { throw new Error('Native attachment upload outcome unresolved; reconcile before retry'); }
        throw error;
      }
    }
    refs.push({ ref, fileName: attachment.filename, mime: attachment.mimeType, bytes: attachment.sizeBytes });
  }
  return refs;
}
const imageLimit = 10 * 1024 * 1024, textLimit = 256 * 1024;
function imageMime(bytes: Buffer): string {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    let offset = 8, imageData = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), end = offset + size + 12;
      if (end > bytes.length) break;
      const kind = bytes.subarray(offset+4,offset+8).toString('ascii');
      if (crc32(bytes.subarray(offset+4,end-4)) !== bytes.readUInt32BE(end-4).toString(16).padStart(8,'0')) break;
      if (offset === 8 && (kind !== 'IHDR' || size !== 13 || !bytes.readUInt32BE(offset+8) || !bytes.readUInt32BE(offset+12))) break;
      if (kind === 'IDAT' && size > 0) imageData = true;
      offset = end;
      if (kind === 'IEND') { ended = size === 0 && end === bytes.length; break; }
    }
    if (ended && imageData) return 'image/png';
    throw new Error('Malformed PNG structure or checksum');
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.subarray(-2).equals(Buffer.from([255,217]))) return 'image/jpeg';
  if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0,6).toString('ascii')) && bytes.readUInt16LE(6) && bytes.readUInt16LE(8) && bytes.at(-1) === 59) return 'image/gif';
  if (bytes.length >= 20 && bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.readUInt32LE(4)+8 === bytes.length && bytes.subarray(8,12).toString('ascii') === 'WEBP' && ['VP8 ','VP8L','VP8X'].includes(bytes.subarray(12,16).toString('ascii'))) return 'image/webp';
  throw new Error('Unsupported or malformed image; use PNG, JPEG, GIF or WebP');
}
export function convertAttachments(input: readonly unknown[], cwd: string) {
  const texts: string[] = [], attachments: NativeAttachment[] = [], metadata: Record<string, unknown>[] = [];
  for (const [index, item] of input.entries()) {
    const i = record(item);
    if (i.type === 'text') { if (typeof i.text !== 'string') throw new Error('Invalid text input'); texts.push(i.text); continue; }
    if (!['image','localImage','localFile'].includes(String(i.type))) throw new Error('Unsupported input attachment');
    let bytes: Buffer, localPath: string | undefined, inlineMime: string | undefined;
    const isImage = i.type !== 'localFile';
    const limit = isImage ? imageLimit : textLimit;
    if (i.type === 'image' && typeof i.url === 'string' && i.url.startsWith('data:')) {
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(i.url);
      if (!match || !match[2] || match[2].length > Math.ceil(limit / 3) * 4) throw new Error('Malformed or oversized inline image');
      bytes = Buffer.from(match[2], 'base64');
      if (bytes.toString('base64') !== match[2]) throw new Error('Malformed image base64');
      inlineMime = match[1];
    } else {
      let path = i.type === 'image' ? i.url : i.path;
      if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('Invalid attachment path');
      if (i.type === 'image') {
        if (!path.startsWith('file:')) throw new Error('Remote image URLs are unsupported; attach a local image or a base64 data URL');
        try { path = fileURLToPath(path); } catch { throw new Error('Invalid local image URL'); }
      }
      localPath = resolve(cwd, String(path));
      let fd: number | undefined;
      try {
        fd = openSync(localPath, constants.O_RDONLY | constants.O_NONBLOCK); const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size === 0 || stat.size > limit) throw new Error('Attachment must be a nonempty regular file within the size limit');
        bytes = readFileSync(fd);
      } catch { throw new Error('Attachment unreadable, empty, not a regular file or too large'); }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    if (!bytes.length || bytes.length > limit) throw new Error('Attachment size limit exceeded');
    if (i.sizeBytes !== undefined && (!Number.isSafeInteger(i.sizeBytes) || i.sizeBytes !== bytes.length)) throw new Error('Attachment size metadata does not match the file');
    let mimeType: string;
    if (isImage) {
      mimeType = imageMime(bytes);
      if (inlineMime && inlineMime !== mimeType) throw new Error('Image MIME does not match its bytes');
    } else {
      if (bytes.subarray(0,5).toString('ascii') === '%PDF-' || localPath?.toLowerCase().endsWith('.pdf')) throw new Error('PDF files are unsupported; attach UTF-8 text');
      try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error(); }
      catch { throw new Error('Only UTF-8 text files are supported; PDF and binary files are unsupported'); }
      mimeType = 'text/plain';
    }
    const filename = i.name === undefined ? (localPath ? basename(localPath) : `image-${index + 1}.${mimeType.split('/')[1]}`) : i.name;
    if (typeof filename !== 'string' || !filename.trim() || /[\x00-\x1f\x7f]/.test(filename)) throw new Error('Invalid attachment name');
    const attachment: NativeAttachment = { kind: isImage ? 'image' : 'file', filename, mimeType, sizeBytes: bytes.length,
      ...(localPath ? { localPath } : { dataBase64: bytes.toString('base64') }) };
    attachments.push(attachment);
    metadata.push({ index, inputType: i.type, kind: attachment.kind, mimeType, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), filenameSha256: createHash('sha256').update(filename).digest('hex'), transport: localPath ? 'localPath' : 'dataBase64' });
  }
  return { text: texts.join('\n'), attachments, metadata };
}
export function requireImageCapability(models: readonly unknown[], model: string): void {
  const selected = models.map(record).find(m => m.model === model);
  if (selected?.supportsImage === true) return;
  const alternatives = models.map(record).filter(m => m.supportsImage === true).map(m => String(m.displayName ?? m.model));
  throw new Error(`${selected?.supportsImage === false ? 'Selected model does not support image input' : 'Selected model image capability is unknown'}. Choose a model with Vision${alternatives.length ? ': ' + alternatives.join(', ') : ' in ZCode, then refresh the catalogue'}.`);
}
