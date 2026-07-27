# login-application

Three-tier login app: React frontend + Node/Express backend + Postgres,
each frontend/backend as its own container image in ECR, deployed to ECS
(EC2 launch type). On a successful login, the backend publishes an event to
an SQS queue. GitHub Actions builds and pushes images to ECR and redeploys
ECS on every push.

**This repo intentionally does not include Lambda code or a SQL schema
file** — you're writing the Lambda function yourself directly when you
create it in AWS, and creating the `users`/`login_audit` tables yourself by
connecting to RDS and running your own queries. The repo only contains
what actually needs to live in source control and CI/CD: the frontend, the
backend, and the SQS integration.

**All AWS resources are created manually with the AWS CLI — see
[`MANUAL_SETUP.md`](./MANUAL_SETUP.md)** for the full step-by-step guide.

## Repository structure

```
login-application/
├── frontend/                 React app (Vite), served by Nginx in prod
│   ├── src/
│   │   ├── components/LoginForm.jsx
│   │   ├── components/RegisterForm.jsx
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   └── api.js
│   ├── Dockerfile
│   ├── nginx.conf
│   └── package.json
│
├── backend/                  Node.js / Express API
│   ├── src/
│   │   ├── config/database.js       DB pool only — does NOT create tables
│   │   ├── config/validateEnv.js    fail-fast required-env-var check
│   │   ├── controllers/authController.js
│   │   ├── routes/authRoutes.js
│   │   ├── services/sqsService.js   sends a message to SQS on login success
│   │   ├── middleware/errorHandler.js
│   │   └── app.js
│   ├── Dockerfile
│   └── package.json
│
├── .github/workflows/
│   ├── deploy-frontend.yml    builds/pushes frontend image, redeploys ECS
│   └── deploy-backend.yml     builds/pushes backend image, redeploys ECS
│
├── MANUAL_SETUP.md            step-by-step AWS CLI guide (no Terraform)
└── README.md
```

## Architecture

```
User -> ALB -> "/"       -> Frontend ECS service (Nginx serving the React build)
             -> "/api/*" -> Backend ECS service (Express)

Backend on POST /api/login:
  1. Checks username/password against RDS Postgres directly (synchronous —
     the user gets an immediate success/failure).
  2. On success, publishes a login event to SQS (fire-and-forget).

From there, SQS -> Lambda -> RDS (login_audit) -> SNS -> email is wired up
and coded entirely on the AWS side by you — this repo only produces the
message that lands in the queue.
```

## Database tables

The backend expects two tables to already exist before it starts:

```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE login_audit (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    username VARCHAR(100),
    email VARCHAR(255),
    status VARCHAR(50),
    login_time TIMESTAMP
);
```

`users` is required by the backend (`authController.js` reads/writes it,
and `app.js` refuses to start if it's missing). `login_audit` is only
needed by whatever Lambda code you write. Create both yourself by
connecting to RDS with `psql`/DBeaver/pgAdmin and running your own
`CREATE TABLE` statements — the backend does not create them for you.

## Getting started

1. Follow [`MANUAL_SETUP.md`](./MANUAL_SETUP.md) — it creates the AWS
   resources via the CLI, up to and including the SQS queue, and gets the
   app running behind an ALB.
2. Connect to RDS yourself and create the `users` (and, once you've
   written your Lambda, `login_audit`) tables.
3. Create your Lambda function (your own code), subscribe it to the SQS
   queue with an event source mapping, and create the SNS topic + email
   subscription — none of that is provided by this repo.
4. Push this repo to GitHub and follow the GitHub OIDC section of
   `MANUAL_SETUP.md` to wire up GitHub Actions so future pushes to `main`
   automatically rebuild and redeploy the frontend/backend.

## Local development (no AWS needed)

```bash
docker run -e POSTGRES_PASSWORD=pass -e POSTGRES_DB=logindb -p 5432:5432 -d postgres:15
psql "host=localhost port=5432 dbname=logindb user=postgres password=pass" \
  -c "CREATE TABLE users (id SERIAL PRIMARY KEY, username VARCHAR(100) UNIQUE NOT NULL, email VARCHAR(255) UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);"

cd backend
cp .env.example .env      # set DB_HOST=localhost, DB_SSL=false, NODE_ENV=development,
                           # leave SQS_QUEUE_URL blank
npm install
npm start                  # http://localhost:3000

cd ../frontend
npm install
npm run dev                 # http://localhost:5173
```

With `NODE_ENV` unset or `development`, a missing `SQS_QUEUE_URL` only logs
a warning instead of exiting — the backend still runs end-to-end locally,
just without publishing login events. Set `NODE_ENV=production` (as the
ECS task definition does) to get the fail-fast behavior described above.
