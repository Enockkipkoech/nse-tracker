import { config } from "dotenv";
import path from "node:path";
import { defineConfig, env } from "prisma/config";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

config({ path: path.resolve(__dirname, "../../.env") });


export default defineConfig({
    schema: "prisma/schema.prisma",
    migrations: {
        path: "prisma/migrations",
        seed: "tsx prisma/seed.ts",
    },
    datasource: {
        url: env("DATABASE_URL"),
        directUrl: env("DIRECT_URL"),
    },
});