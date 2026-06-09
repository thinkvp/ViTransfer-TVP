import { getS3Client, getS3Bucket } from '../src/lib/s3-storage';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
async function main() {
  const client = getS3Client();
  const bucket = getS3Bucket();
  // Search all prefixes for the Share Only project
  const prefixes = [
    'clients/Simba McSimba Industries/projects/Share Only/videos/',
    'clients/Simba McSimba Industries/projects/Share Only/.previews/videos/',
    'projects/Share Only/',
    'projects/202',
  ];
  for (const prefix of prefixes) {
    const cmd = new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 5 });
    const resp = await client.send(cmd);
    console.log('--- Prefix:', prefix, '--- Count:', resp.KeyCount);
    for (const obj of (resp.Contents || []).slice(0, 5)) console.log('  ', obj.Key);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
