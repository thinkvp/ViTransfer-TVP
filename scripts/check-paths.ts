import { isS3Mode, getS3Client, getS3Bucket, s3FileExists } from '../src/lib/s3-storage';
async function main() {
  const paths = [
    'clients/Simba McSimba Industries/projects/Share Only/videos/VIDEO 1 - Intro/v2/VIDEO 1 - Intro - v2.mp4',
    'clients/Simba McSimba Industries/projects/Share Only/.previews/videos/VIDEO 1 - Intro/v2/preview-720p.mp4',
    'clients/Simba McSimba Industries/projects/Share Only/.previews/videos/VIDEO 1 - Intro/v2/thumbnail.jpg',
  ];
  for (const p of paths) {
    try {
      const exists = await s3FileExists(p);
      console.log(exists ? 'EXISTS' : 'MISSING', p);
    } catch (e: any) {
      console.log('ERROR', p, e.message);
    }
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
