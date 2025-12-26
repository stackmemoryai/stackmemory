# Agents Reference Guide

## AI Agent Instructions for ML System Design

This document provides specific instructions for AI agents working with ML systems, referencing insights from [ML_SYSTEM_INSIGHTS.md](./ML_SYSTEM_INSIGHTS.md).

---

## 🤖 For Coding Agents

### When Building ML Systems

#### 1. **Start with Architecture Pattern**
Reference: `ML_SYSTEM_INSIGHTS.md#universal-architecture-patterns`

```python
# Always implement the three-layer stack
class MLSystem:
    def __init__(self):
        self.offline_training = OfflineTrainer()
        self.nearline_processing = StreamProcessor()
        self.online_serving = PredictionServer()
```

#### 2. **Feature Store Implementation**
```python
# Standard feature store interface
class FeatureStore:
    def get_online_features(self, entity_ids: List[str]) -> DataFrame
    def get_offline_features(self, entity_ids: List[str], timestamp: datetime) -> DataFrame
    def register_feature(self, feature_def: FeatureDefinition) -> None
```

#### 3. **Model Serving Checklist**
- [ ] Implement health checks
- [ ] Add request validation
- [ ] Set up caching layer
- [ ] Configure timeout handling
- [ ] Add fallback mechanism
- [ ] Implement gradual rollout

### Error Handling Patterns

```python
# Always implement fallback strategies
class PredictionService:
    def predict(self, request):
        try:
            return self.primary_model.predict(request)
        except ModelTimeout:
            return self.fallback_model.predict(request)
        except Exception as e:
            log_error(e)
            return self.default_response()
```

---

## 🔍 For Analysis Agents

### System Analysis Framework

Reference: `ML_SYSTEM_INSIGHTS.md#key-design-decisions`

#### 1. **Performance Analysis Checklist**
- [ ] Check latency percentiles (p50, p95, p99)
- [ ] Analyze throughput bottlenecks
- [ ] Review cache hit rates
- [ ] Evaluate model complexity vs accuracy trade-off
- [ ] Assess infrastructure costs

#### 2. **Data Quality Assessment**
```python
# Standard data quality checks
quality_metrics = {
    "completeness": check_missing_values(),
    "consistency": check_data_types(),
    "timeliness": check_data_freshness(),
    "validity": check_value_ranges(),
    "uniqueness": check_duplicates()
}
```

#### 3. **Drift Detection Analysis**
- Monitor feature distributions
- Track prediction distributions
- Analyze label shift
- Evaluate concept drift
- Check upstream data changes

### Root Cause Analysis Template

1. **Symptom**: What is the observed issue?
2. **Impact**: Business metrics affected
3. **Timeline**: When did it start?
4. **Hypothesis**: Potential causes (reference common pitfalls)
5. **Investigation**: Data/logs to examine
6. **Resolution**: Fix and prevention

---

## 📝 For Documentation Agents

### ML System Documentation Template

Reference: `ML_SYSTEM_INSIGHTS.md#system-design-templates`

#### 1. **System Overview**
```markdown
## System Name

### Purpose
[Business problem being solved]

### Architecture
[Reference architecture pattern from ML_SYSTEM_INSIGHTS.md]

### Key Metrics
- Business: [Revenue, engagement]
- Model: [Accuracy, AUC]
- System: [Latency, throughput]
```

#### 2. **Data Pipeline Documentation**
```markdown
## Data Pipeline

### Sources
- Source A: [Description, update frequency]
- Source B: [Description, update frequency]

### Transformations
1. [Step 1]: [Description]
2. [Step 2]: [Description]

### Output Schema
| Field | Type | Description |
|-------|------|-------------|
| user_id | string | Unique user identifier |
| features | array | Computed feature vector |
```

#### 3. **Model Documentation**
```markdown
## Model Specification

### Training
- Algorithm: [e.g., XGBoost, BERT]
- Training Frequency: [Daily, Weekly]
- Data Window: [e.g., Last 90 days]

### Serving
- Latency SLA: [e.g., <100ms p99]
- Throughput: [e.g., 10K QPS]
- Deployment: [e.g., Kubernetes, SageMaker]

### Monitoring
- Alerts: [List of alert conditions]
- Dashboards: [Links to dashboards]
- On-call: [Team responsible]
```

---

## 🏗️ For Architecture Agents

### Design Decision Framework

Reference: `ML_SYSTEM_INSIGHTS.md#scaling-strategies`

#### 1. **Batch vs Real-time Decision Tree**
```
if latency_requirement < 100ms:
    use_real_time()
elif predictions_per_day > 1_million:
    use_batch()
elif features_change_frequently:
    use_nearline()
else:
    use_hybrid()
```

#### 2. **Technology Selection Guide**

| Component | Small Scale | Medium Scale | Large Scale |
|-----------|------------|--------------|-------------|
| Feature Store | PostgreSQL | Redis + PostgreSQL | Feast/Tecton |
| Model Training | Scikit-learn | XGBoost/LightGBM | Distributed TensorFlow |
| Model Serving | Flask | FastAPI + Redis | TorchServe/Triton |
| Monitoring | CloudWatch | Datadog | Custom stack |

#### 3. **Scaling Recommendations**
- **Vertical**: Upgrade instance types for quick wins
- **Horizontal**: Add replicas for stateless services
- **Caching**: Implement multi-tier caching
- **Async**: Move non-critical paths to async

---

## 🔧 For DevOps Agents

### MLOps Implementation Guide

Reference: `ML_SYSTEM_INSIGHTS.md#mlops-maturity-levels`

#### 1. **CI/CD Pipeline Setup**
```yaml
# .github/workflows/ml-pipeline.yml
steps:
  - data_validation
  - feature_engineering
  - model_training
  - model_validation
  - staged_deployment
  - monitoring_setup
```

#### 2. **Infrastructure as Code**
```terraform
# Standard ML infrastructure
module "ml_platform" {
  feature_store = true
  model_registry = true
  experiment_tracking = true
  monitoring = true
  serving_infrastructure = true
}
```

#### 3. **Monitoring Setup**
```python
# Essential metrics to track
metrics = {
    "model": ["accuracy", "auc", "f1"],
    "system": ["latency_p99", "error_rate", "throughput"],
    "business": ["conversion_rate", "revenue_impact"],
    "data": ["feature_coverage", "null_rate", "drift_score"]
}
```

---

## 🧪 For Testing Agents

### ML Testing Strategy

Reference: `ML_SYSTEM_INSIGHTS.md#best-practices-for-production-ml`

#### 1. **Test Pyramid for ML**
```
         /\
        /  \  End-to-end tests (5%)
       /    \
      /      \  Integration tests (15%)
     /        \
    /          \  Component tests (30%)
   /            \
  /______________\  Unit tests (50%)
```

#### 2. **Test Categories**
```python
# Data validation tests
def test_feature_ranges():
    assert features["age"].min() >= 0
    assert features["age"].max() <= 120

# Model validation tests
def test_model_performance():
    assert model.evaluate(test_data)["auc"] > 0.75

# System integration tests
def test_prediction_latency():
    assert predict_latency_p99() < 100  # ms

# A/B test validation
def test_experiment_setup():
    assert treatment_allocation == 0.5
    assert minimum_sample_size_met()
```

---

## 🚨 For Debugging Agents

### Troubleshooting Guide

Reference: `ML_SYSTEM_INSIGHTS.md#common-pitfalls-solutions`

#### 1. **Debug Decision Tree**
```
Performance Issue?
├── Yes → Check System Metrics
│   ├── High Latency → Profile code, check caching
│   ├── Low Throughput → Scale horizontally
│   └── High Error Rate → Check logs, validate inputs
└── No → Check Model Metrics
    ├── Low Accuracy → Analyze data drift, retrain
    ├── Bias Issues → Check data distribution
    └── Overfitting → Add regularization, reduce complexity
```

#### 2. **Common Issues & Solutions**

| Symptom | Likely Cause | Solution |
|---------|-------------|----------|
| Predictions all same | Feature pipeline broken | Validate feature generation |
| Sudden accuracy drop | Data drift | Implement drift detection |
| Slow predictions | Model too complex | Use model distillation |
| Memory leaks | Caching issues | Implement TTL, monitor memory |
| Training fails | Data quality issues | Add data validation |

---

## 📊 For Monitoring Agents

### Observability Setup

Reference: `ML_SYSTEM_INSIGHTS.md#monitoring-observability`

#### 1. **Alert Configuration**
```yaml
alerts:
  - name: model_accuracy_degradation
    condition: accuracy < 0.8
    severity: warning
    
  - name: high_latency
    condition: p99_latency > 200ms
    severity: critical
    
  - name: data_drift_detected
    condition: ks_statistic > 0.1
    severity: warning
```

#### 2. **Dashboard Requirements**
- Model performance metrics (real-time)
- System health indicators
- Data quality metrics
- Business impact metrics
- Cost tracking

---

## 🔄 Quick Reference for All Agents

### Priority Order for ML Systems
1. **Correctness**: Ensure predictions are accurate
2. **Reliability**: System stays up and handles failures
3. **Latency**: Meet performance requirements
4. **Scalability**: Handle growth in usage
5. **Efficiency**: Optimize resource usage

### Universal Checklist
- [ ] Data validation implemented
- [ ] Model versioning in place
- [ ] Monitoring configured
- [ ] Rollback mechanism ready
- [ ] Documentation complete
- [ ] Tests passing
- [ ] Security review done
- [ ] Cost analysis performed

### When to Escalate
- Data privacy concerns
- Security vulnerabilities
- Significant accuracy degradation
- System-wide outages
- Budget overruns

---

*Reference: [ML_SYSTEM_INSIGHTS.md](./ML_SYSTEM_INSIGHTS.md) for detailed patterns and examples*
*Last Updated: December 2024*