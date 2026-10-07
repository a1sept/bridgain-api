import { RequestsController } from "./workspace/requests.controller.js";
import { RequestsService } from "./workspace/requests.service.js";
import { WorkspaceController } from "./workspace/workspace.controller.js";
import { WorkspaceService } from "./workspace/workspace.service.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { Module } from "@nestjs/common";
import { DatabaseService } from "./db/database.service.js";
import { HealthController } from "./health.controller.js";
@Module({
  controllers: [
    HealthController,
    AuthController,
    WorkspaceController,
    RequestsController,
  ],
  providers: [
    DatabaseService,
    AuthService,
    WorkspaceService,
    WorkspaceController,
    RequestsService,
  ],
})
export class AppModule {}
