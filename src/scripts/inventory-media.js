require('dotenv').config();
const pool = require('../core/db/pool');

async function main() {
  const client = await pool.connect();
  try {
    const postMedia = await client.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN url LIKE '%cloudinary%' THEN 1 END) as cloudinary_count,
        COUNT(CASE WHEN url LIKE '%r2.dev%' THEN 1 END) as r2_count,
        COUNT(CASE WHEN master_url IS NOT NULL THEN 1 END) as has_master_count
      FROM post_media
    `);
    console.log('Post Media:', postMedia.rows[0]);

    const postMediaClouds = await client.query(`
      SELECT 
        split_part(split_part(url, 'res.cloudinary.com/', 2), '/', 1) as cloud_name,
        COUNT(*) as count
      FROM post_media
      WHERE url LIKE '%res.cloudinary.com%'
      GROUP BY 1
    `);
    console.log('Cloudinary clouds in post_media:', postMediaClouds.rows);

    const userCols = await client.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'users'
    `);
    console.log('User columns:', userCols.rows.map(r => r.column_name).filter(c => c.includes('url') || c.includes('avatar') || c.includes('cover') || c.includes('image')));

    const profileCols = await client.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'profiles'
    `);
    console.log('Profile columns:', profileCols.rows.map(r => r.column_name).filter(c => c.includes('url') || c.includes('avatar') || c.includes('cover') || c.includes('image')));

    const userAvatars = await client.query(`
      SELECT 
        COUNT(*) as total_users,
        COUNT(CASE WHEN avatar_url LIKE '%cloudinary%' THEN 1 END) as cld_avatars,
        COUNT(CASE WHEN avatar_url LIKE '%googleusercontent%' THEN 1 END) as google_avatars,
        COUNT(CASE WHEN avatar_url LIKE '%r2.dev%' THEN 1 END) as r2_avatars
      FROM users
    `);
    console.log('Users avatar stats:', userAvatars.rows[0]);

    const userCovers = await client.query(`
      SELECT 
        COUNT(CASE WHEN cover_image_url LIKE '%cloudinary%' THEN 1 END) as cld_covers
      FROM users
    `);
    console.log('User cover stats:', userCovers.rows[0]);

    const orgs = await client.query(`
      SELECT 
        COUNT(*) as total_orgs,
        COUNT(CASE WHEN logo_url LIKE '%cloudinary%' THEN 1 END) as cld_logos,
        COUNT(CASE WHEN cover_url LIKE '%cloudinary%' THEN 1 END) as cld_covers
      FROM organizations
    `);
    console.log('Orgs:', orgs.rows[0]);

    const achievements = await client.query(`
      SELECT COUNT(*) as total, COUNT(CASE WHEN cloudinary_url LIKE '%cloudinary%' THEN 1 END) as cld FROM achievement_images
    `);
    console.log('Achievement images:', achievements.rows[0]);

    const resumes = await client.query(`
      SELECT COUNT(*) as total, COUNT(CASE WHEN file_url LIKE '%cloudinary%' THEN 1 END) as cld FROM user_resumes
    `);
    console.log('User resumes:', resumes.rows[0]);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
