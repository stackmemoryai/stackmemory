#!/bin/bash

# Runway Deployment Script for StackMemory MCP Server
# Production deployment with comprehensive checks

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ENVIRONMENT="${1:-production}"
PROJECT_NAME="stackmemory-mcp"
REQUIRED_ENV_VARS=(
  "AUTH0_DOMAIN"
  "AUTH0_AUDIENCE"
  "AUTH0_CLIENT_ID"
  "AUTH0_CLIENT_SECRET"
  "DATABASE_URL"
  "REDIS_URL"
  "JWT_SECRET"
  "DATADOG_API_KEY"
  "SENTRY_DSN"
)

# Logging functions
log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
  exit 1
}

# Check prerequisites
check_prerequisites() {
  log_info "Checking prerequisites..."
  
  # Check for required tools
  for tool in docker node npm runway pg_isready redis-cli; do
    if ! command -v $tool &> /dev/null; then
      log_error "$tool is not installed"
    fi
  done
  
  # Check Node version
  NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VERSION" -lt 20 ]; then
    log_error "Node.js 20 or higher is required (current: v$NODE_VERSION)"
  fi
  
  # Check environment variables
  for var in "${REQUIRED_ENV_VARS[@]}"; do
    if [ -z "${!var:-}" ]; then
      log_error "Environment variable $var is not set"
    fi
  done
  
  log_success "All prerequisites met"
}

# Run tests
run_tests() {
  log_info "Running tests..."
  
  # Unit tests
  npm test || log_error "Unit tests failed"
  
  # Integration tests
  npm run test:integration || log_error "Integration tests failed"
  
  # Security scan
  npm audit --production || log_warning "Security vulnerabilities found"
  
  log_success "All tests passed"
}

# Build application
build_application() {
  log_info "Building application..."
  
  # Clean previous builds
  rm -rf dist
  
  # Install dependencies
  npm ci --production=false
  
  # Build TypeScript
  npm run build
  
  # Verify build
  if [ ! -f "dist/src/runway/index.js" ]; then
    log_error "Build failed: main entry point not found"
  fi
  
  log_success "Application built successfully"
}

# Build Docker image
build_docker_image() {
  log_info "Building Docker image..."
  
  # Generate build tag
  VERSION=$(node -p "require('./package.json').version")
  BUILD_TAG="${PROJECT_NAME}:${VERSION}-${ENVIRONMENT}"
  LATEST_TAG="${PROJECT_NAME}:latest-${ENVIRONMENT}"
  
  # Build image
  docker build \
    --file Dockerfile.runway \
    --tag "$BUILD_TAG" \
    --tag "$LATEST_TAG" \
    --build-arg NODE_ENV="$ENVIRONMENT" \
    --platform linux/amd64 \
    .
  
  # Tag for registry
  REGISTRY_URL="${RUNWAY_REGISTRY:-registry.runway.app}"
  docker tag "$BUILD_TAG" "$REGISTRY_URL/$BUILD_TAG"
  docker tag "$LATEST_TAG" "$REGISTRY_URL/$LATEST_TAG"
  
  log_success "Docker image built: $BUILD_TAG"
}

# Database migrations
run_migrations() {
  log_info "Running database migrations..."
  
  # Check database connection
  if ! pg_isready -d "$DATABASE_URL"; then
    log_error "Cannot connect to database"
  fi
  
  # Run migrations using docker
  docker run --rm \
    -e DATABASE_URL="$DATABASE_URL" \
    "${PROJECT_NAME}:latest-${ENVIRONMENT}" \
    node dist/src/runway/database/migrate.js
  
  log_success "Database migrations completed"
}

# Health checks
perform_health_checks() {
  log_info "Performing health checks..."
  
  # Start services locally for testing
  docker-compose -f docker-compose.runway.yml up -d
  
  # Wait for services to be ready
  sleep 10
  
  # Check application health
  HEALTH_RESPONSE=$(curl -s http://localhost:8080/health)
  if ! echo "$HEALTH_RESPONSE" | grep -q '"healthy":true'; then
    log_error "Health check failed: $HEALTH_RESPONSE"
  fi
  
  # Check database
  docker exec stackmemory-postgres pg_isready -U stackmemory || log_error "Database not ready"
  
  # Check Redis
  docker exec stackmemory-redis redis-cli ping || log_error "Redis not ready"
  
  # Stop services
  docker-compose -f docker-compose.runway.yml down
  
  log_success "All health checks passed"
}

# Deploy to Runway
deploy_to_runway() {
  log_info "Deploying to Runway ($ENVIRONMENT)..."
  
  # Login to Runway
  runway login || log_error "Failed to login to Runway"
  
  # Validate configuration
  runway validate || log_error "Runway configuration validation failed"
  
  # Push Docker image
  docker push "$REGISTRY_URL/${PROJECT_NAME}:${VERSION}-${ENVIRONMENT}"
  
  # Deploy with canary strategy
  runway deploy \
    --environment "$ENVIRONMENT" \
    --strategy canary \
    --canary-percentage 10 \
    --canary-duration 30m \
    --wait \
    --timeout 600
  
  # Verify deployment
  runway status "$PROJECT_NAME" --environment "$ENVIRONMENT"
  
  log_success "Deployment successful"
}

# Smoke tests
run_smoke_tests() {
  log_info "Running smoke tests..."
  
  # Get deployment URL
  DEPLOYMENT_URL=$(runway url "$PROJECT_NAME" --environment "$ENVIRONMENT")
  
  # Test health endpoint
  curl -f "$DEPLOYMENT_URL/health" || log_error "Health endpoint failed"
  
  # Test metrics endpoint
  curl -f "$DEPLOYMENT_URL/metrics" || log_error "Metrics endpoint failed"
  
  # Test authentication
  TEST_TOKEN=$(./scripts/get-test-token.sh)
  curl -f -H "Authorization: Bearer $TEST_TOKEN" \
    "$DEPLOYMENT_URL/api/v1/projects" || log_error "Authentication test failed"
  
  log_success "Smoke tests passed"
}

# Monitor deployment
monitor_deployment() {
  log_info "Monitoring deployment for 5 minutes..."
  
  START_TIME=$(date +%s)
  MONITOR_DURATION=300 # 5 minutes
  
  while true; do
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))
    
    if [ $ELAPSED -gt $MONITOR_DURATION ]; then
      break
    fi
    
    # Check error rate
    ERROR_RATE=$(runway metrics "$PROJECT_NAME" --metric error_rate --duration 1m)
    if (( $(echo "$ERROR_RATE > 0.05" | bc -l) )); then
      log_warning "High error rate detected: $ERROR_RATE"
    fi
    
    # Check latency
    LATENCY=$(runway metrics "$PROJECT_NAME" --metric p95_latency --duration 1m)
    if (( $(echo "$LATENCY > 2000" | bc -l) )); then
      log_warning "High latency detected: ${LATENCY}ms"
    fi
    
    sleep 30
  done
  
  log_success "Monitoring complete"
}

# Rollback if needed
rollback_deployment() {
  log_error "Deployment failed, rolling back..."
  
  runway rollback "$PROJECT_NAME" \
    --environment "$ENVIRONMENT" \
    --to-previous \
    --wait
  
  log_info "Rollback completed"
  exit 1
}

# Notification
send_notification() {
  local STATUS=$1
  local MESSAGE=$2
  
  # Slack notification
  if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
    curl -X POST "$SLACK_WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "{
        \"text\": \"Deployment $STATUS\",
        \"attachments\": [{
          \"color\": \"$([ "$STATUS" == "SUCCESS" ] && echo "good" || echo "danger")\",
          \"fields\": [{
            \"title\": \"Project\",
            \"value\": \"$PROJECT_NAME\",
            \"short\": true
          }, {
            \"title\": \"Environment\",
            \"value\": \"$ENVIRONMENT\",
            \"short\": true
          }, {
            \"title\": \"Message\",
            \"value\": \"$MESSAGE\"
          }]
        }]
      }"
  fi
  
  # Email notification
  if [ -n "${NOTIFICATION_EMAIL:-}" ]; then
    echo "$MESSAGE" | mail -s "Deployment $STATUS: $PROJECT_NAME" "$NOTIFICATION_EMAIL"
  fi
}

# Main deployment flow
main() {
  log_info "Starting deployment for $PROJECT_NAME to $ENVIRONMENT"
  log_info "================================================"
  
  # Set error trap
  trap 'rollback_deployment' ERR
  
  # Pre-deployment checks
  check_prerequisites
  
  # Build and test
  run_tests
  build_application
  build_docker_image
  
  # Local verification
  perform_health_checks
  
  # Database setup
  run_migrations
  
  # Deploy
  deploy_to_runway
  
  # Post-deployment verification
  run_smoke_tests
  monitor_deployment
  
  # Success notification
  send_notification "SUCCESS" "Deployment completed successfully"
  
  log_success "================================================"
  log_success "Deployment completed successfully!"
  log_success "URL: $(runway url "$PROJECT_NAME" --environment "$ENVIRONMENT")"
}

# Run main function
main "$@"