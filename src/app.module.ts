import { WorkspaceController } from "./workspace/workspace.controller.js";
import { WorkspaceService } from "./workspace/workspace.service.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthService } from "./auth/auth.service.js";
import { Module } from "@nestjs/common";
import { DatabaseService } from "./db/database.service.js";
import { HealthController } from "./health.controller.js";
@Module({
  controllers: [HealthController, AuthController, WorkspaceController],
  providers: [
    DatabaseService,
    AuthService,
    WorkspaceService,
    WorkspaceController,
  ],
})
export class AppModule {}
