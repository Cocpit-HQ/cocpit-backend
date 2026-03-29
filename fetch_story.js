const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const stories = await prisma.story.findMany({
    orderBy: { created_at: 'desc' },
    take: 5
  });
  for (const story of stories) {
    console.log("Story ID:", story.id);
    console.log(JSON.stringify(story.story_metadata, null, 2));
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
