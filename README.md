# API

공통 백엔드를 두는 폴더입니다.
실행 설정은 루트에서 관리하고 Compose에서 필요한 값만 전달합니다.

NestJS + TypeScript, PostgreSQL, Drizzle ORM 및 Drizzle Kit를 사용합니다.
마이그레이션 파일은 이 프로젝트에서 관리합니다. Socket.IO는 현재 범위에 포함하지 않습니다.

독립 저장소 `a1sept/bridgain-api`이며, 상위 `bridgain`의 `apps/api` 서브모듈로 관리합니다.
현재는 프로젝트 준비 파일만 있으며 NestJS 및 DB 연동 구현은 아직 진행하지 않았습니다.
