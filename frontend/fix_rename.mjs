import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('..');
const OUTPUTS = path.join(ROOT, 'outputs');
const PROMPTS = path.join(ROOT, 'prompts');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE || 'video_generator',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '',
  connectionTimeoutMillis: 3000,
});

async function main() {
  console.log('=== Fixing rename: Revert to "2 cute kids dance and sing together" ===\n');

  // 1. Delete Duck Dance from Postgres
  console.log('1. Removing "Duck Dance" from database...');
  await pool.query('DELETE FROM scenario_versions WHERE name = $1', ['Duck Dance']);
  await pool.query('DELETE FROM scenarios WHERE name = $1', ['Duck Dance']);
  await pool.query('DELETE FROM projects WHERE name = $1', ['Duck Dance']);
  console.log('   Done.\n');

  // 2. Fix the outputs folder: move files from "2 cute kids dance and sing together." to "2 cute kids dance and sing together"
  const badDir = path.join(OUTPUTS, '2 cute kids dance and sing together.');
  const goodDir = path.join(OUTPUTS, '2 cute kids dance and sing together');

  console.log('2. Fixing outputs folder...');
  if (!fs.existsSync(badDir)) {
    console.log('   Bad dir does not exist, nothing to move.');
  } else {
    const files = fs.readdirSync(badDir);
    console.log(`   Found ${files.length} files in bad dir.`);

    for (const file of files) {
      if (file === 'state.json' || file === 'concat_list.txt') continue;

      // Rename prefix: "Duck Dance_" -> "2 cute kids dance and sing together_"
      let newFile = file.replace(/^Duck Dance_/, '2 cute kids dance and sing together_');
      if (newFile === file) {
        newFile = file.replace(/^Duck Dance/, '2 cute kids dance and sing together');
      }

      const src = path.join(badDir, file);
      const dst = path.join(goodDir, newFile);

      if (fs.existsSync(dst)) {
        console.log(`   SKIP (exists): ${newFile}`);
        continue;
      }

      fs.renameSync(src, dst);
      console.log(`   MOVED: ${file} -> ${newFile}`);
    }

    // Handle state.json - merge or replace
    const badState = path.join(badDir, 'state.json');
    const goodState = path.join(goodDir, 'state.json');

    if (fs.existsSync(badState)) {
      const badSt = JSON.parse(fs.readFileSync(badState, 'utf8'));
      const goodSt = fs.existsSync(goodState) ? JSON.parse(fs.readFileSync(goodState, 'utf8')) : { ref: null, beats: {}, pinned: { ref: false, beats: {} } };

      // Merge beats from bad into good (bad has the 134 beats)
      for (const [k, v] of Object.entries(badSt.beats || {})) {
        goodSt.beats[k] = v;
      }
      if (badSt.ref) goodSt.ref = badSt.ref.replace(/^Duck Dance_/, '2 cute kids dance and sing together_');
      if (badSt.pinned) goodSt.pinned = badSt.pinned;

      fs.writeFileSync(goodState, JSON.stringify(goodSt, null, 2));
      console.log('   Merged state.json');
    }

    // Remove the bad dir
    fs.rmSync(badDir, { recursive: true });
    console.log('   Removed bad folder.\n');
  }

  // 3. Fix any remaining files in good dir with "Duck Dance" prefix
  console.log('3. Fixing any remaining wrong prefixes in good dir...');
  const goodFiles = fs.readdirSync(goodDir);
  for (const file of goodFiles) {
    if (file.startsWith('Duck Dance')) {
      const newFile = file.replace(/^Duck Dance/, '2 cute kids dance and sing together');
      fs.renameSync(path.join(goodDir, file), path.join(goodDir, newFile));
      console.log(`   RENAMED: ${file} -> ${newFile}`);
    }
  }
  console.log('   Done.\n');

  // 4. Verify
  console.log('4. Verification:');
  const finalFiles = fs.readdirSync(goodDir).filter(f => f !== '.gitkeep');
  console.log(`   Files in ${goodDir}: ${finalFiles.length}`);
  const byType = {};
  for (const f of finalFiles) {
    const ext = path.extname(f);
    byType[ext] = (byType[ext] || 0) + 1;
  }
  console.log('   By type:', byType);

  // 5. Clean up prompts - keep original, remove Duck Dance.json
  const duckPrompt = path.join(PROMPTS, 'Duck Dance.json');
  if (fs.existsSync(duckPrompt)) {
    fs.renameSync(duckPrompt, duckPrompt + '.bak');
    console.log('\n5. Backed up prompts/Duck Dance.json to .bak');
  }

  await pool.end();
  console.log('\n=== Done. Restart the server to see the merged project. ===');
}

main().catch(e => { console.error(e); process.exit(1); });