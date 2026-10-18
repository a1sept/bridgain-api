import { ProjectRolesController } from "./workspace/project-roles.controller.js";
import { StagedWorkController } from "./workspace/staged-work.controller.js";
import { StagedWorkService } from "./workspace/staged-work.service.js";
import { StageSettingsController } from "./workspace/stage-settings.controller.js";
import { StageSettingsService } from "./workspace/stage-settings.service.js";
import { ProjectRolesService } from "./workspace/project-roles.service.js";
import { ApprovalService } from "./workspace/approval.service.js";
import { ApprovalController } from "./workspace/approval.controller.js";
import { GithubConnectionController } from "./workspace/github-connection.controller.js";
import { GithubConnectionService } from "./workspace/github-connection.service.js";
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
    StagedWorkController,
    StageSettingsController,
    ProjectRolesController,
    ApprovalController,
    GithubConnectionController,
    AiController,
    HealthController,
    AuthController,
    WorkspaceController,
    RequestsController,
    ProjectWorkController,
    GitEventsController,
  ],
  providers: [
    StagedWorkService,
    StageSettingsService,
    ProjectRolesService,
    ApprovalService,
    GithubConnectionService,
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
