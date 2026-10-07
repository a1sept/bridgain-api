import { ProjectWorkController } from "./workspace/project-work.controller.js";
import { ProjectWorkService } from "./workspace/project-work.service.js";
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
    ProjectWorkController,
  ],
  providers: [
    DatabaseService,
    AuthService,
    WorkspaceService,
    WorkspaceController,
    RequestsService,
    ProjectWorkService,
  ],
})
export class AppModule {}
