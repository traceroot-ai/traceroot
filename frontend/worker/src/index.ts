import { prisma } from "@traceroot/core";

async function main() {
  console.log("Traceroot Worker starting...");

  // Example: test database connection
  const projectCount = await prisma.project.count();
  console.log(`Connected to database. Found ${projectCount} projects.`);
}

main().catch(console.error);
