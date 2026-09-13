import { Module } from '@nestjs/common';
import { DatabaseService } from './db/database.service.js';
import { HealthController } from './health.controller.js';

@Module({ controllers: [HealthController], providers: [DatabaseService] })
export class AppModule {}
