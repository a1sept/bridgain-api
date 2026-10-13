import { TaskReviewService } from "./workspace/task-review.service.js";
import { AiController } from "./workspace/ai.controller.js";
import { AiService } from "./workspace/ai.service.js";
import { GitEventsController } from "./workspace/git-events.controller.js";
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
    AiController,
    HealthController,
    AuthController,
    WorkspaceController,
    RequestsController,
    ProjectWorkController,
    GitEventsController,
  ],
  providers: [
    AiService,
    DatabaseService,
    AuthService,
    WorkspaceService,
    WorkspaceController,
    RequestsService,
    ProjectWorkService,
    TaskReviewService,
  ],
})
export class AppModule {}
