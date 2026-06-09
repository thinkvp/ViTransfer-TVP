import { getS3Client, getS3Bucket } from '../src/lib/s3-storage';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
async function main() {
  const client = getS3Client();
  const bucket = getS3Bucket();
  // Search for the missing video files anywhere in the bucket
  const search = 'VIDEO 1 - Intro';
  const cmd = new ListObjectsV2Command({ Bucket: bucket, Prefix: '', MaxKeys: 100 });
  let found = [];
  let token;
  do {
    if (token) cmd.input.ContinuationToken = token;
    const resp = await client.send(cmd);
    for (const obj of (resp.Contents || [])) {
      if (obj.Key && obj.Key.includes(search)) found.push(obj.Key);
    }
    token = resp.NextContinuationToken;
    if (found.length > 0) break;
  } while (token);
  console.log('Found:', found.length, 'matching', search);
  found.slice(0, 10).forEach(k => console.log(k));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
