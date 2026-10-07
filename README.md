# Bridgain API

NestJS + TypeScript + PostgreSQL + Drizzle 기반 공통 API입니다. 이메일을 ID로 사용하는 가입·로그인·세션 복원을 구현했습니다. 이메일 인증·발송·비밀번호 복구는 보류합니다. 팀·프로젝트·초대·업무 기능은 후속 범위입니다.

## 개발 실행

상위 `bridgain` 저장소의 루트 `.env.dev`와 `compose.dev.yaml`로 실행합니다. 이 저장소 안에 실제 환경 파일을 만들거나 커밋하지 않습니다. Node.js 24를 사용하며 패키지는 `npm ci`로 설치합니다.

API에 필요한 환경변수는 `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME`입니다. Compose가 필요한 값만 주입합니다. `PORT` 기본값은 3000입니다. 비밀번호를 URL에 이어 붙이지 않고 PostgreSQL 연결 설정으로 전달합니다.

- `npm run dev`: TypeScript 변경 감지 및 재시작
- `npm run build`: 실행 코드 빌드
- `npm start`: 빌드된 API 실행
- `npm run typecheck`: 타입 검사
- `npm test`: 상태 확인·오류 비공개 처리·환경변수·입력·CSRF·쿠키·계정 유형·요청 제한 검증

`GET /api/health`는 DB에 `SELECT 1`을 수행한 뒤 연결 성공 시 200, 실패 시 503을 반환합니다. 이는 DB 연결 검사이며 모든 마이그레이션 적용 여부까지 보장하지 않습니다. 프론트는 Vite 개발 프록시를 통해 `/api`에 접근합니다.

## DB 구조 변경

1. `src/db/schema/`의 TypeScript 테이블 정의를 수정합니다.
2. `npm run db:generate -- --name change_description`으로 SQL과 스냅샷을 생성합니다. 이 단계는 DB 연결이 필요 없습니다.
3. 생성된 `drizzle/` SQL을 검토합니다. 컬럼 삭제·데이터 변환은 별도 검토가 필요합니다.
4. 환경변수가 주입된 API 컨테이너에서 `npm run db:migrate`를 실행합니다.
5. 스키마·SQL·메타데이터를 API 저장소에서 함께 버전 관리합니다.

상위 폴더에서 적용하는 예:

```bash
docker compose --env-file .env.dev -p bridgain-dev -f compose.dev.yaml run --rm api npm run db:migrate
```

마이그레이션은 API 프로세스와 분리된 명령입니다. 상위 Compose는 별도 migrate 작업이 성공한 뒤 API를 시작하도록 구성합니다. 이미 적용된 파일은 수정하지 않고 새 마이그레이션을 생성합니다. `db:push`나 DB 초기화 스크립트는 제공하지 않습니다. 초기 마이그레이션은 개발 기반 확인용 `app_metadata` 테이블 하나만 생성합니다.

## 의존성 호환성

Nest CLI의 컴파일러 API 호환성을 위해 TypeScript 6을 사용합니다. `package.json`의 제한된 overrides는 Nest Express 어댑터의 Multer를 2.3 이상으로, Drizzle Kit의 레거시 로더 내부 esbuild를 0.25.12 이상으로 고정해 알려진 보안 문제를 피합니다. 의존성 업데이트 시 빌드·테스트·마이그레이션 생성을 다시 검증하세요.


## 인증

현재 사용하는 테이블은 `users`, `password_credentials`, `auth_sessions`입니다. 기존 `auth_tokens`와 `users.email_verified_at`은 적용된 DB 이력을 보존하기 위해 남겨두지만 현재 인증 과정에서 사용하지 않습니다. 새 계정의 이메일을 인증된 것으로 표시하지 않습니다.

- 가입: 이름·이메일·12~128자 비밀번호, 201 성공 후 바로 로그인 가능. 중복 이메일 409 `EMAIL_IN_USE`.
- 계정 유형: 신뢰 프록시 경로에 따라 `client`/`team`. 직무·관리 권한은 별개입니다.
- 비밀번호: Argon2id, memoryCost 19456 KiB / timeCost 2 / parallelism 1.
- 세션: 난수 32바이트, DB에 SHA-256 해시. 기본 24시간, 로그인 유지 14일. 앱별 HttpOnly·SameSite=Lax·host-only 쿠키, 운영 Secure.
- `GET /api/auth/csrf` 응답을 모든 POST의 `X-CSRF-Token` 헤더로 전달합니다. 앱별 CSRF 쿠키와 허용 Origin을 검사합니다.
- 프록시는 `x-bridgain-app`, `x-bridgain-proxy-secret`, `x-bridgain-client-ip`를 덮어씁니다. 인증값은 프론트 번들에 노출하지 않습니다.
- 요청 제한은 단일 프로세스 메모리의 계정/IP 기준입니다. 다중 인스턴스에서는 공유 저장소가 필요합니다.

현재 API: `GET /auth/csrf`, `POST /auth/signup`, `POST /auth/login`, `GET /auth/me`, `POST /auth/logout` (모두 `/api` prefix). 기존 인증·재발송·비밀번호 재설정 API는 404이며 과거 토큰으로도 실행할 수 없습니다. SMTP 환경변수와 메일 발송 라이브러리는 필요 없습니다.

| 환경변수 | 의미 / 기본값 |
| --- | --- |
| `AUTH_PROXY_SECRET` | 필수 32자 이상. API·프록시 서버만 공유 |
| `CLIENT_APP_ORIGIN` | `http://localhost:15173` |
| `DEVELOPER_APP_ORIGIN` | `http://localhost:15174` |

이메일 소유 확인·비밀번호 찾기는 후속 기능이며 제공되는 것처럼 안내하지 않습니다. 초대는 이메일 소유 여부를 신뢰하지 않고 고유 사용자 ID로 대상을 연결하고 상대방의 수락을 요구할 예정입니다. 팀·프로젝트 권한, 메일 기능 재도입, 만료 레코드 정리는 별도 설계합니다.
