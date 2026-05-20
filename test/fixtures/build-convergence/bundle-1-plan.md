# Living Plan: Bundle 1 Crypto

## Feature 1: Dependency setup

### Phase 1: Setup
- [ ] **Test Specification (test-writer role)**: tests for crypto deps load
- [ ] **Implementation (primary-impl role)**: install deps, add types
- [ ] **Review & QA (review roles)**: run /review

### Phase 2: EIP-712 digest
- [ ] **Test Specification (test-writer role)**: digest produces correct hash
- [ ] **Implementation (primary-impl role)**: implement digest fn
- [ ] **Review & QA (review roles)**: run /review

### Phase 3: Clerk DID
- [ ] **Test Specification (test-writer role)**: DID resolution unique
- [ ] **Implementation (primary-impl role)**: implement clerk DID
- [ ] **Review & QA (review roles)**: run /review

#### Test Spec
1. EIP-712 digest with chainId produces expected hash
2. Clerk DID resolution handles simultaneous device registration
3. Message log payload split preserves order
**Coverage target: ≥80%**
