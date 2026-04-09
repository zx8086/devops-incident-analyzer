# Kafka Consumer Lag Investigation

## Symptoms
- Consumer group lag exceeding threshold (>10,000 messages)
- Processing latency increasing
- Downstream services showing stale data

## Investigation Steps

### 1. Identify Lagging Consumer Groups
List all consumer groups and their lag per partition. Determine if lag is growing, stable, or recovering.

### 2. Check Consumer Instance Health
Verify the number of active consumers in the group matches expected count. Look for recent rebalancing events that may indicate consumer crashes or slow joins.

### 3. Analyze Partition Distribution
Check if lag is concentrated on specific partitions (hot partition) or distributed across all partitions (throughput bottleneck).

### 4. Check Producer Throughput
Compare current producer rate with historical baseline. A sudden spike in production rate can cause temporary lag even with healthy consumers.

### 5. Cross-Reference with Backend Services
Check Elasticsearch logs for the consumer application. Look for processing errors, deserialization failures, or external dependency timeouts that slow message processing.

### 6. Check for Dead Letter Topic Activity
If the consumer has a DLQ configured, check message count and recent entries. Poison messages can stall processing of an entire partition.

## Escalation Criteria
- Lag >100,000 and growing: page on-call
- Consumer group has 0 active members: immediate escalation
- Lag causing user-visible staleness: notify product team

## Recovery Actions (Require Human Approval)
- Reset consumer offset to latest (data loss trade-off)
- Scale consumer instances
- Temporarily increase partition count
