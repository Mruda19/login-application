# Manual AWS Setup Guide (No Terraform)

Step-by-step AWS CLI walkthrough to build the whole architecture by hand.
Run every command from a terminal with AWS CLI v2 + Docker installed and
`aws configure` already set up. Commands are meant to run in order, in the
same shell session (later steps reuse variables set earlier).

## Contents

1. Prerequisites
2. Variables
3. Networking (default VPC)
4. Security groups
5. ECR
6. RDS
7. **Run the database schema (one-time, manual)**
8. SQS
9. SNS
10. IAM roles
11. Lambda
12. ECS EC2 cluster
13. Application Load Balancer
14. ECS task definitions
15. ECS services
16. Testing
17. GitHub OIDC + GitHub Actions
18. Cleanup
19. Troubleshooting

---

## 1. Prerequisites

- AWS CLI v2, configured (`aws configure`) with a user/role that can create
  IAM, EC2, ECS, ECR, RDS, SQS, SNS, and Lambda resources
- Docker
- `psql` (or another Postgres client — DBeaver, pgAdmin) to run the schema
  once against RDS
- An email address you can access, to confirm the SNS subscription

## 2. Variables

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

export PROJECT=login-app
export CLUSTER_NAME=login-app-cluster
export FRONTEND_ECR=login-frontend
export BACKEND_ECR=login-backend
export FRONTEND_SERVICE=login-app-frontend-svc
export BACKEND_SERVICE=login-app-backend-svc
export LAMBDA_NAME=login-app-login-audit
export SQS_NAME=login-app-login-events
export SNS_NAME=login-app-login-notifications
export DB_INSTANCE_ID=login-app-db
export DB_NAME=logindb
export DB_USERNAME=appuser
export DB_PASSWORD='ChangeMe123!'     # pick your own strong password
export NOTIFICATION_EMAIL='you@example.com'

echo "Account: $ACCOUNT_ID  Region: $AWS_REGION"
```

## 3. Networking (default VPC)

This guide uses your account's **default VPC and its public subnets** to
keep setup manageable — no custom VPC, route tables, Internet Gateway, or
NAT Gateway to create. This is fine for a learning project. See the
"Hardening notes" at the very end for what to change for production
(private subnets + NAT Gateway or VPC endpoints for RDS/ECS/Lambda).

```bash
export VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

export SUBNET_IDS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[].SubnetId' --output text)
export SUBNET_ARRAY=($SUBNET_IDS)
export SUBNET_1=${SUBNET_ARRAY[0]}
export SUBNET_2=${SUBNET_ARRAY[1]}

echo "VPC: $VPC_ID"
echo "Subnets: $SUBNET_IDS"
```

## 4. Security groups

```bash
# ALB - open to the internet on port 80
export ALB_SG=$(aws ec2 create-security-group --group-name ${PROJECT}-alb-sg \
  --description "ALB security group" --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $ALB_SG \
  --protocol tcp --port 80 --cidr 0.0.0.0/0

# ECS EC2 instances - only reachable from the ALB, dynamic host port range
export ECS_SG=$(aws ec2 create-security-group --group-name ${PROJECT}-ecs-sg \
  --description "ECS instances security group" --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $ECS_SG \
  --protocol tcp --port 32768-65535 --source-group $ALB_SG

# Lambda ENIs
export LAMBDA_SG=$(aws ec2 create-security-group --group-name ${PROJECT}-lambda-sg \
  --description "Lambda security group" --vpc-id $VPC_ID --query GroupId --output text)

# RDS - only reachable from ECS instances and Lambda (both need port 5432)
export RDS_SG=$(aws ec2 create-security-group --group-name ${PROJECT}-rds-sg \
  --description "RDS security group" --vpc-id $VPC_ID --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $RDS_SG \
  --protocol tcp --port 5432 --source-group $ECS_SG
aws ec2 authorize-security-group-ingress --group-id $RDS_SG \
  --protocol tcp --port 5432 --source-group $LAMBDA_SG

echo "ALB_SG=$ALB_SG  ECS_SG=$ECS_SG  LAMBDA_SG=$LAMBDA_SG  RDS_SG=$RDS_SG"
```

You will also temporarily need to reach RDS on 5432 from **your own
machine** to run the schema in step 7. Easiest for a learning project:
allow your current IP, and remove the rule again afterwards.

```bash
export MY_IP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress --group-id $RDS_SG \
  --protocol tcp --port 5432 --cidr ${MY_IP}/32
```

(If you'd rather not expose RDS publicly even briefly, run the schema from
an EC2 instance/Cloud9 environment inside the VPC instead, and skip this
rule + `--publicly-accessible` in step 6.)

## 5. ECR repositories

```bash
aws ecr create-repository --repository-name $FRONTEND_ECR
aws ecr create-repository --repository-name $BACKEND_ECR

export FRONTEND_REPO_URI=$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$FRONTEND_ECR
export BACKEND_REPO_URI=$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$BACKEND_ECR
echo "$FRONTEND_REPO_URI"
echo "$BACKEND_REPO_URI"
```

Build and push the images now (first time, manually — GitHub Actions takes
over after that):

```bash
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

docker build -t $FRONTEND_REPO_URI:latest ./frontend
docker push $FRONTEND_REPO_URI:latest

docker build -t $BACKEND_REPO_URI:latest ./backend
docker push $BACKEND_REPO_URI:latest
```

## 6. RDS Postgres

```bash
aws rds create-db-subnet-group \
  --db-subnet-group-name ${PROJECT}-db-subnet-group \
  --db-subnet-group-description "Login app DB subnet group" \
  --subnet-ids $SUBNET_IDS

aws rds create-db-instance \
  --db-instance-identifier $DB_INSTANCE_ID \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --engine-version 15 \
  --master-username $DB_USERNAME \
  --master-user-password $DB_PASSWORD \
  --allocated-storage 20 \
  --db-name $DB_NAME \
  --vpc-security-group-ids $RDS_SG \
  --db-subnet-group-name ${PROJECT}-db-subnet-group \
  --backup-retention-period 1 \
  --publicly-accessible

echo "Waiting for RDS to become available (this takes several minutes)..."
aws rds wait db-instance-available --db-instance-identifier $DB_INSTANCE_ID

export DB_HOST=$(aws rds describe-db-instances --db-instance-identifier $DB_INSTANCE_ID \
  --query 'DBInstances[0].Endpoint.Address' --output text)
echo "RDS endpoint: $DB_HOST"
```

> `--publicly-accessible` here is only so you can run the schema from your
> laptop in the next step. If you're running the schema from inside the
> VPC instead (bastion/Cloud9), use `--no-publicly-accessible` and skip the
> "your own machine" security group rule above.

## 7. Create the database tables (one-time, manual — your own queries)

**The backend does not create tables on startup, and this repo does not
include a schema file.** Connect to RDS yourself and create the tables
with your own `CREATE TABLE` statements before the backend ever connects.
At minimum, the backend requires a `users` table shaped like this (adjust
as you like — this is just what `authController.js` reads/writes):

```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Connect and run it (or your own version) however you prefer — `psql`
shown here as an example:

```bash
psql "host=$DB_HOST port=5432 dbname=$DB_NAME user=$DB_USERNAME password=$DB_PASSWORD"
# then paste your own CREATE TABLE statements at the prompt, e.g. the one above

# Verify:
psql "host=$DB_HOST port=5432 dbname=$DB_NAME user=$DB_USERNAME password=$DB_PASSWORD" \
  -c "\dt"
```

You'll add a second table (e.g. `login_audit`) later, once you've written
your Lambda code and decided what it should store. If you opened RDS to
your IP just for this, you can revoke it now:

```bash
aws ec2 revoke-security-group-ingress --group-id $RDS_SG \
  --protocol tcp --port 5432 --cidr ${MY_IP}/32
```

## 8. SQS queue (+ DLQ)

```bash
export DLQ_URL=$(aws sqs create-queue --queue-name ${SQS_NAME}-dlq --query QueueUrl --output text)
export DLQ_ARN=$(aws sqs get-queue-attributes --queue-url $DLQ_URL \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

export REDRIVE_POLICY="{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"

export QUEUE_URL=$(aws sqs create-queue --queue-name $SQS_NAME \
  --attributes "{\"VisibilityTimeout\":\"60\",\"RedrivePolicy\":\"$(echo $REDRIVE_POLICY | sed 's/"/\\"/g')\"}" \
  --query QueueUrl --output text)

export QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url $QUEUE_URL \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

echo "Queue URL: $QUEUE_URL"
echo "Queue ARN: $QUEUE_ARN"
```

## 9. SNS topic + email subscription

```bash
export SNS_TOPIC_ARN=$(aws sns create-topic --name $SNS_NAME --query TopicArn --output text)

aws sns subscribe \
  --topic-arn $SNS_TOPIC_ARN \
  --protocol email \
  --notification-endpoint $NOTIFICATION_EMAIL

echo "Check $NOTIFICATION_EMAIL and CONFIRM the subscription email — required for delivery."
```

## 10. IAM roles

```bash
# ---- ECS EC2 instance role ----
cat > /tmp/ec2-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF

aws iam create-role --role-name ${PROJECT}-ecs-instance-role \
  --assume-role-policy-document file:///tmp/ec2-trust.json
aws iam attach-role-policy --role-name ${PROJECT}-ecs-instance-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role

aws iam create-instance-profile --instance-profile-name ${PROJECT}-ecs-instance-profile
aws iam add-role-to-instance-profile --instance-profile-name ${PROJECT}-ecs-instance-profile \
  --role-name ${PROJECT}-ecs-instance-role

# ---- ECS task execution role (pull from ECR, write logs) ----
cat > /tmp/ecs-tasks-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF

aws iam create-role --role-name ${PROJECT}-ecs-task-execution-role \
  --assume-role-policy-document file:///tmp/ecs-tasks-trust.json
aws iam attach-role-policy --role-name ${PROJECT}-ecs-task-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# ---- Backend task role (permission to send to SQS) ----
aws iam create-role --role-name ${PROJECT}-backend-task-role \
  --assume-role-policy-document file:///tmp/ecs-tasks-trust.json

cat > /tmp/backend-sqs-policy.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["sqs:SendMessage"],"Resource":"$QUEUE_ARN"}]}
EOF
aws iam put-role-policy --role-name ${PROJECT}-backend-task-role \
  --policy-name ${PROJECT}-backend-sqs-send --policy-document file:///tmp/backend-sqs-policy.json

# ---- Lambda execution role ----
cat > /tmp/lambda-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF

aws iam create-role --role-name ${PROJECT}-lambda-exec-role \
  --assume-role-policy-document file:///tmp/lambda-trust.json
aws iam attach-role-policy --role-name ${PROJECT}-lambda-exec-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam attach-role-policy --role-name ${PROJECT}-lambda-exec-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole
aws iam attach-role-policy --role-name ${PROJECT}-lambda-exec-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole

cat > /tmp/lambda-sns-policy.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["sns:Publish"],"Resource":"$SNS_TOPIC_ARN"}]}
EOF
aws iam put-role-policy --role-name ${PROJECT}-lambda-exec-role \
  --policy-name ${PROJECT}-lambda-sns-publish --policy-document file:///tmp/lambda-sns-policy.json

# IAM role propagation can take ~10s before it's usable
sleep 10

export ECS_INSTANCE_PROFILE_ARN=$(aws iam get-instance-profile \
  --instance-profile-name ${PROJECT}-ecs-instance-profile --query 'InstanceProfile.Arn' --output text)
export ECS_TASK_EXEC_ROLE_ARN=$(aws iam get-role --role-name ${PROJECT}-ecs-task-execution-role --query 'Role.Arn' --output text)
export BACKEND_TASK_ROLE_ARN=$(aws iam get-role --role-name ${PROJECT}-backend-task-role --query 'Role.Arn' --output text)
export LAMBDA_ROLE_ARN=$(aws iam get-role --role-name ${PROJECT}-lambda-exec-role --query 'Role.Arn' --output text)
```

> **Upgrade path:** for anything beyond a learning project, put `DB_USER`/
> `DB_PASSWORD`/`DB_HOST`/`DB_NAME` in **Secrets Manager** instead of plain
> environment variables, and grant the backend task role and Lambda role
> `secretsmanager:GetSecretValue` on that secret's ARN. Not covered here to
> keep the first pass simple, but straightforward to add later.

## 11. Lambda (SQS → RDS + SNS)

**This repo does not include Lambda code — write your own.** Create a
local folder (outside this repo, or anywhere you like) with your function
code, e.g. `my-lambda/index.js`, using the Node.js `pg` package to write to
`login_audit` and the AWS SDK's `@aws-sdk/client-sns` to publish. The
handler receives the SQS message(s) as `event.Records[].body` — that body
is exactly the JSON your backend sent via `sendLoginEvent()` in
`backend/src/services/sqsService.js` (see `authController.js` for the
exact shape: `userId`, `username`, `email`, `status`, `timestamp`).

Once you have your code, zip and deploy it:

```bash
cd my-lambda
npm install --omit=dev
zip -r /tmp/login-audit-lambda.zip . -x "*.git*"
cd ..

aws lambda create-function \
  --function-name $LAMBDA_NAME \
  --runtime nodejs20.x \
  --role $LAMBDA_ROLE_ARN \
  --handler index.handler \
  --timeout 30 \
  --memory-size 256 \
  --zip-file fileb:///tmp/login-audit-lambda.zip \
  --vpc-config SubnetIds=$SUBNET_1,$SUBNET_2,SecurityGroupIds=$LAMBDA_SG \
  --environment "Variables={DB_HOST=$DB_HOST,DB_PORT=5432,DB_USER=$DB_USERNAME,DB_PASSWORD=$DB_PASSWORD,DB_NAME=$DB_NAME,SNS_TOPIC_ARN=$SNS_TOPIC_ARN}"
```

(Adjust `--handler` to match your actual filename/export — `index.handler`
above assumes a file `index.js` exporting `exports.handler = ...`.)

Lambda is placed in the VPC so it can reach RDS on 5432 (already allowed by
the RDS security group rule from step 4: `RDS_SG` accepts 5432 from
`LAMBDA_SG`). It also needs a path to the public SNS API. Two options —
pick one:

**Option A — SNS VPC interface endpoint (no NAT Gateway, no extra data
transfer cost for this traffic):**

```bash
aws ec2 create-vpc-endpoint \
  --vpc-id $VPC_ID \
  --service-name com.amazonaws.$AWS_REGION.sns \
  --vpc-endpoint-type Interface \
  --subnet-ids $SUBNET_1 $SUBNET_2 \
  --security-group-ids $LAMBDA_SG \
  --private-dns-enabled

aws ec2 authorize-security-group-ingress --group-id $LAMBDA_SG \
  --protocol tcp --port 443 --source-group $LAMBDA_SG
```

**Option B — NAT Gateway** (needed anyway if you later add other AWS API
calls or outbound internet access from the VPC; costs more than the
endpoint above). Skip if you did Option A.

Either way, verify Lambda can actually reach both RDS and SNS before
wiring up the trigger — a quick manual test:

```bash
aws lambda invoke --function-name $LAMBDA_NAME \
  --payload '{"Records":[{"body":"{\"userId\":1,\"username\":\"test\",\"email\":\"test@example.com\",\"status\":\"SUCCESS\",\"timestamp\":\"2026-01-01T00:00:00Z\"}"}]}' \
  --cli-binary-format raw-in-base64-out /tmp/lambda-out.json
cat /tmp/lambda-out.json
```

(This will fail with a foreign-key/user-not-found style error since
`userId: 1` won't exist yet — that's fine, it confirms Lambda reached RDS.
A timeout instead means a networking/security-group problem to fix before
continuing.)

Now wire the SQS queue to trigger it automatically:

```bash
aws lambda create-event-source-mapping \
  --function-name $LAMBDA_NAME \
  --event-source-arn $QUEUE_ARN \
  --batch-size 5 \
  --enabled
```

## 12. ECS cluster (EC2 launch type)

```bash
aws ecs create-cluster --cluster-name $CLUSTER_NAME

# Latest ECS-optimized Amazon Linux 2 AMI
export ECS_AMI_ID=$(aws ssm get-parameters \
  --names /aws/service/ecs/optimized-ami/amazon-linux-2/recommended/image_id \
  --query 'Parameters[0].Value' --output text)

cat > /tmp/user-data.sh <<EOF
#!/bin/bash
echo ECS_CLUSTER=$CLUSTER_NAME >> /etc/ecs/ecs.config
EOF

export LT_ID=$(aws ec2 create-launch-template \
  --launch-template-name ${PROJECT}-ecs-lt \
  --launch-template-data "{
    \"ImageId\": \"$ECS_AMI_ID\",
    \"InstanceType\": \"t3.small\",
    \"IamInstanceProfile\": {\"Arn\": \"$ECS_INSTANCE_PROFILE_ARN\"},
    \"SecurityGroupIds\": [\"$ECS_SG\"],
    \"UserData\": \"$(base64 -w0 /tmp/user-data.sh)\"
  }" --query 'LaunchTemplate.LaunchTemplateId' --output text)

aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name ${PROJECT}-ecs-asg \
  --launch-template LaunchTemplateId=$LT_ID,Version='$Latest' \
  --min-size 1 --max-size 2 --desired-capacity 1 \
  --vpc-zone-identifier "$SUBNET_1,$SUBNET_2" \
  --new-instances-protected-from-scale-in

export ASG_ARN=$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names ${PROJECT}-ecs-asg \
  --query 'AutoScalingGroups[0].AutoScalingGroupARN' --output text)

aws ecs create-capacity-provider \
  --name ${PROJECT}-cp \
  --auto-scaling-group-provider "autoScalingGroupArn=$ASG_ARN,managedScaling={status=ENABLED,targetCapacity=100},managedTerminationProtection=ENABLED"

aws ecs put-cluster-capacity-providers \
  --cluster $CLUSTER_NAME \
  --capacity-providers ${PROJECT}-cp \
  --default-capacity-provider-strategy capacityProvider=${PROJECT}-cp,weight=1

echo "Waiting ~1-2 minutes for the EC2 instance to register with the cluster..."
sleep 90
aws ecs list-container-instances --cluster $CLUSTER_NAME
```

If that last command returns an empty list, see Troubleshooting (§19)
before moving on — the ECS services in step 15 can't place tasks without a
registered container instance.

## 13. Application Load Balancer

```bash
export ALB_ARN=$(aws elbv2 create-load-balancer \
  --name ${PROJECT}-alb \
  --subnets $SUBNET_1 $SUBNET_2 \
  --security-groups $ALB_SG \
  --scheme internet-facing --type application \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

export ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns $ALB_ARN \
  --query 'LoadBalancers[0].DNSName' --output text)

export FRONTEND_TG_ARN=$(aws elbv2 create-target-group \
  --name ${PROJECT}-frontend-tg --protocol HTTP --port 80 \
  --vpc-id $VPC_ID --target-type instance \
  --health-check-path / --matcher HttpCode=200 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

export BACKEND_TG_ARN=$(aws elbv2 create-target-group \
  --name ${PROJECT}-backend-tg --protocol HTTP --port 3000 \
  --vpc-id $VPC_ID --target-type instance \
  --health-check-path /api/health --matcher HttpCode=200 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

export LISTENER_ARN=$(aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn=$FRONTEND_TG_ARN \
  --query 'Listeners[0].ListenerArn' --output text)

aws elbv2 create-rule \
  --listener-arn $LISTENER_ARN --priority 10 \
  --conditions Field=path-pattern,Values='/api/*' \
  --actions Type=forward,TargetGroupArn=$BACKEND_TG_ARN

echo "App URL (once services are running): http://$ALB_DNS"
```

Note the backend health check hits `/api/health`, which now also checks
DB connectivity (`SELECT 1`) — if RDS or the schema isn't reachable, the
backend will report unhealthy here rather than looking fine and failing
silently later.

## 14. ECS task definitions

```bash
cat > /tmp/frontend-taskdef.json <<EOF
{
  "family": "login-app-frontend",
  "networkMode": "bridge",
  "requiresCompatibilities": ["EC2"],
  "cpu": "256",
  "memory": "256",
  "executionRoleArn": "$ECS_TASK_EXEC_ROLE_ARN",
  "containerDefinitions": [
    {
      "name": "frontend",
      "image": "$FRONTEND_REPO_URI:latest",
      "essential": true,
      "portMappings": [{ "containerPort": 80, "hostPort": 0, "protocol": "tcp" }]
    }
  ]
}
EOF
aws ecs register-task-definition --cli-input-json file:///tmp/frontend-taskdef.json

cat > /tmp/backend-taskdef.json <<EOF
{
  "family": "login-app-backend",
  "networkMode": "bridge",
  "requiresCompatibilities": ["EC2"],
  "cpu": "256",
  "memory": "256",
  "executionRoleArn": "$ECS_TASK_EXEC_ROLE_ARN",
  "taskRoleArn": "$BACKEND_TASK_ROLE_ARN",
  "containerDefinitions": [
    {
      "name": "backend",
      "image": "$BACKEND_REPO_URI:latest",
      "essential": true,
      "portMappings": [{ "containerPort": 3000, "hostPort": 0, "protocol": "tcp" }],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "DB_HOST", "value": "$DB_HOST" },
        { "name": "DB_PORT", "value": "5432" },
        { "name": "DB_USER", "value": "$DB_USERNAME" },
        { "name": "DB_PASSWORD", "value": "$DB_PASSWORD" },
        { "name": "DB_NAME", "value": "$DB_NAME" },
        { "name": "SQS_QUEUE_URL", "value": "$QUEUE_URL" },
        { "name": "AWS_REGION", "value": "$AWS_REGION" },
        { "name": "PORT", "value": "3000" }
      ]
    }
  ]
}
EOF
aws ecs register-task-definition --cli-input-json file:///tmp/backend-taskdef.json
```

`NODE_ENV=production` here matters: with the env-validation added to
`app.js`/`sqsService.js`, a missing required variable now makes the backend
exit loudly on startup (or log a hard error before silently dropping login
events) instead of quietly limping along — check `aws ecs describe-tasks`
or CloudWatch logs if the backend service won't go steady.

## 15. ECS services

```bash
aws ecs create-service \
  --cluster $CLUSTER_NAME \
  --service-name $FRONTEND_SERVICE \
  --task-definition login-app-frontend \
  --desired-count 1 \
  --capacity-provider-strategy capacityProvider=${PROJECT}-cp,weight=1 \
  --load-balancers targetGroupArn=$FRONTEND_TG_ARN,containerName=frontend,containerPort=80

aws ecs create-service \
  --cluster $CLUSTER_NAME \
  --service-name $BACKEND_SERVICE \
  --task-definition login-app-backend \
  --desired-count 1 \
  --capacity-provider-strategy capacityProvider=${PROJECT}-cp,weight=1 \
  --load-balancers targetGroupArn=$BACKEND_TG_ARN,containerName=backend,containerPort=3000
```

Give it a couple of minutes, then check both services are steady:

```bash
aws ecs describe-services --cluster $CLUSTER_NAME --services $FRONTEND_SERVICE $BACKEND_SERVICE \
  --query 'services[].{name:serviceName,status:status,running:runningCount,desired:desiredCount}'
```

## 16. Testing

```bash
echo "http://$ALB_DNS"
```

Open that URL:
1. Register a user.
2. Log in with that user.
3. You should get an SNS email within a few seconds, and a new row in
   `login_audit`:

```bash
psql "host=$DB_HOST port=5432 dbname=$DB_NAME user=$DB_USERNAME password=$DB_PASSWORD" \
  -c "SELECT * FROM login_audit ORDER BY id DESC LIMIT 5;"
```

---

## 17. GitHub OIDC + GitHub Actions

The repo includes `.github/workflows/deploy-frontend.yml` and
`deploy-backend.yml` (there's no `deploy-lambda.yml` — your Lambda code
isn't part of this repo, so deploy/update it yourself with `aws lambda
update-function-code` whenever you change it). Both workflows assume an
IAM role via OIDC — no AWS access keys stored in GitHub.

**Push the code:**

```bash
git init
git add .
git commit -m "Initial commit: three-tier login app"
git branch -M main
git remote add origin https://github.com/<your-username>/login-application.git
git push -u origin main
```

**Create the OIDC provider** (skip if your account already has one):

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

**Create the deploy role, trusted only by your repo's `main` branch:**

```bash
export GITHUB_ORG=<your-github-username-or-org>
export GITHUB_REPO=login-application

cat > /tmp/github-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::$ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:$GITHUB_ORG/$GITHUB_REPO:ref:refs/heads/main" }
    }
  }]
}
EOF

aws iam create-role --role-name ${PROJECT}-github-actions-deploy-role \
  --assume-role-policy-document file:///tmp/github-trust.json

export FRONTEND_REPO_ARN=$(aws ecr describe-repositories --repository-names $FRONTEND_ECR --query 'repositories[0].repositoryArn' --output text)
export BACKEND_REPO_ARN=$(aws ecr describe-repositories --repository-names $BACKEND_ECR --query 'repositories[0].repositoryArn' --output text)
export FRONTEND_SVC_ARN=$(aws ecs describe-services --cluster $CLUSTER_NAME --services $FRONTEND_SERVICE --query 'services[0].serviceArn' --output text)
export BACKEND_SVC_ARN=$(aws ecs describe-services --cluster $CLUSTER_NAME --services $BACKEND_SERVICE --query 'services[0].serviceArn' --output text)

cat > /tmp/github-actions-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["ecr:GetAuthorizationToken"], "Resource": "*" },
    {
      "Effect": "Allow",
      "Action": ["ecr:BatchCheckLayerAvailability","ecr:PutImage","ecr:InitiateLayerUpload","ecr:UploadLayerPart","ecr:CompleteLayerUpload","ecr:BatchGetImage"],
      "Resource": ["$FRONTEND_REPO_ARN", "$BACKEND_REPO_ARN"]
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:UpdateService","ecs:DescribeServices"],
      "Resource": ["$FRONTEND_SVC_ARN", "$BACKEND_SVC_ARN"]
    }
  ]
}
EOF

aws iam put-role-policy --role-name ${PROJECT}-github-actions-deploy-role \
  --policy-name ${PROJECT}-gha-deploy-policy --policy-document file:///tmp/github-actions-policy.json

export GITHUB_ROLE_ARN=$(aws iam get-role --role-name ${PROJECT}-github-actions-deploy-role --query 'Role.Arn' --output text)
echo "GITHUB_ROLE_ARN=$GITHUB_ROLE_ARN"
```

**Add the GitHub secret:** in your repo, **Settings → Secrets and
variables → Actions → New repository secret**:
- Name: `AWS_GITHUB_ROLE_ARN`
- Value: `$GITHUB_ROLE_ARN` printed above

**Deploy via git push** from now on:

```bash
git add .
git commit -m "some change"
git push origin main
```

- `frontend/**` changes → `deploy-frontend.yml` rebuilds/pushes and
  force-redeploys the frontend ECS service.
- `backend/**` changes → same, for the backend service.
- Lambda changes are yours to redeploy manually (or set up your own CI for
  it, separately) with `aws lambda update-function-code`, since the
  function's code doesn't live in this repo.

---

## 18. Cleanup (avoid ongoing charges)

```bash
aws ecs update-service --cluster $CLUSTER_NAME --service $FRONTEND_SERVICE --desired-count 0
aws ecs update-service --cluster $CLUSTER_NAME --service $BACKEND_SERVICE --desired-count 0
aws ecs delete-service --cluster $CLUSTER_NAME --service $FRONTEND_SERVICE
aws ecs delete-service --cluster $CLUSTER_NAME --service $BACKEND_SERVICE
aws elbv2 delete-listener --listener-arn $LISTENER_ARN
aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
aws elbv2 delete-target-group --target-group-arn $FRONTEND_TG_ARN
aws elbv2 delete-target-group --target-group-arn $BACKEND_TG_ARN
aws autoscaling update-auto-scaling-group --auto-scaling-group-name ${PROJECT}-ecs-asg --min-size 0 --desired-capacity 0
# wait for instances to terminate, then:
aws autoscaling delete-auto-scaling-group --auto-scaling-group-name ${PROJECT}-ecs-asg
aws ecs delete-capacity-provider --capacity-provider ${PROJECT}-cp
aws ecs delete-cluster --cluster $CLUSTER_NAME
aws lambda delete-event-source-mapping --uuid <mapping-uuid-from-list-event-source-mappings>
aws lambda delete-function --function-name $LAMBDA_NAME
aws rds delete-db-instance --db-instance-identifier $DB_INSTANCE_ID --skip-final-snapshot
aws sqs delete-queue --queue-url $QUEUE_URL
aws sqs delete-queue --queue-url $DLQ_URL
aws sns delete-topic --topic-arn $SNS_TOPIC_ARN
aws ecr delete-repository --repository-name $FRONTEND_ECR --force
aws ecr delete-repository --repository-name $BACKEND_ECR --force
```

## 19. Troubleshooting

**`aws ecs list-container-instances` returns an empty list / ECS service
stuck at 0 running tasks with "no container instances":**
- Check the EC2 instance actually launched:
  `aws ec2 describe-instances --filters Name=tag:Name,Values=login-app-ecs-instance`
- SSH or use SSM Session Manager into it and check
  `cat /var/log/ecs/ecs-agent.log` for registration errors.
- Most common cause: the instance can't reach the internet to pull the
  ECS agent/register with the cluster. In the default public subnets this
  usually means the instance has no public IP — public subnets need
  "auto-assign public IP" enabled, or add
  `"NetworkInterfaces": [{"AssociatePublicIpAddress": true, ...}]` to the
  launch template.
- Confirm `${PROJECT}-ecs-instance-role` has
  `AmazonEC2ContainerServiceforEC2Role` attached and the instance profile
  is actually attached to the instance.

**Backend ECS tasks keep cycling / target group shows unhealthy:**
- `/api/health` now checks DB connectivity — an unhealthy result usually
  means RDS isn't reachable (check `RDS_SG` allows 5432 from `ECS_SG`) or
  the schema wasn't run (§7) so `users` doesn't exist, which makes the
  backend `process.exit(1)` on startup by design.
- Check logs: `aws logs tail /ecs/login-app-backend --follow` (create the
  log group / add a `logConfiguration` block to the task definition if you
  want CloudWatch logs — omitted above to keep the JSON short).

**Login succeeds but no email ever arrives:**
- Confirm the SNS email subscription (check inbox/spam for the
  confirmation link — unconfirmed subscriptions never deliver).
- Check `SQS_QUEUE_URL` is actually set on the backend task (with
  `NODE_ENV=production`, a missing value now logs a loud error — check
  CloudWatch logs for "SQS_QUEUE_URL is not set in production").
- Check the Lambda has actually been invoked:
  `aws lambda get-function --function-name $LAMBDA_NAME --query 'Configuration.LastModified'`
  and check its CloudWatch log group `/aws/lambda/login-app-login-audit`
  for errors (commonly: Lambda's security group can't reach RDS, or can't
  reach the SNS endpoint — see §11).

## Hardening notes for later

- **Networking**: everything here sits in the default VPC's public
  subnets, including RDS and the ECS EC2 instances. For production, put
  RDS and ECS instances in private subnets with a NAT Gateway (or VPC
  endpoints) for egress, and keep only the ALB public.
- **Secrets**: DB password is a plain environment variable in the task
  definition and Lambda config here. Move to Secrets Manager for anything
  beyond a personal project (see the note in §10).
- **HTTPS**: add an ACM certificate and an HTTPS listener on the ALB.
- **Image tags**: the workflows push both `:latest` and `:<git-sha>` but
  deploy via `--force-new-deployment` against `:latest`. For guaranteed,
  traceable deployments, register a new task definition revision with the
  SHA-tagged image on every deploy instead.
