import "reflect-metadata";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { parsePort } from "./config.js";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.useBodyParser("json", { limit: "1mb" });
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
  await app.listen(parsePort(process.env.PORT ?? "3000", "PORT"), "0.0.0.0");
}

void bootstrap().catch(() => {
  console.error(
    "API startup failed. Check required environment variables and port availability.",
  );
  process.exitCode = 1;
});
