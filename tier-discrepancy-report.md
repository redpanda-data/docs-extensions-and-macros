# Redpanda Cloud Tier Discrepancy Report

Generated on: 2025-10-01

## Executive Summary

- **Total Tiers Analyzed**: 41
- **Total Issues Found**: 147
- **🔴 Critical Issues**: 115
- **🟠 Major Issues**: 32
- **🟡 Moderate Issues**: 0
- **🟢 Minor Issues**: 17

## Detailed Analysis

### AWS

#### Tier 1 (im4gn.large)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 19.1 Mbps | 12.7 Mbps | -33.3% | 🟠 major |
| Egress Throughput | 57.2 Mbps | 38.1 Mbps | -33.3% | 🟠 major |
| Max Partitions | 2,000 | 6,198 | +209.9% | 🔴 critical |
| Max Client Connections | 9,000 | 3,700 | -58.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% lower than advertised
- Egress Throughput: Config is 33.3% lower than advertised
- Max Partitions: Config is 209.9% higher than advertised
- Max Client Connections: Config is 58.9% lower than advertised

#### Tier 1 (m7gd.large)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 19.1 Mbps | 31.8 Mbps | +66.7% | 🔴 critical |
| Egress Throughput | 57.2 Mbps | 95.4 Mbps | +66.7% | 🔴 critical |
| Max Partitions | 2,000 | 6,198 | +209.9% | 🔴 critical |
| Max Client Connections | 9,000 | 3,700 | -58.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 66.7% higher than advertised
- Egress Throughput: Config is 66.7% higher than advertised
- Max Partitions: Config is 209.9% higher than advertised
- Max Client Connections: Config is 58.9% lower than advertised

#### Tier 1 - x86 (i3en.large)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 19.1 Mbps | 12.7 Mbps | -33.3% | 🟠 major |
| Egress Throughput | 57.2 Mbps | 38.1 Mbps | -33.3% | 🟠 major |
| Max Partitions | 2,000 | 6,198 | +209.9% | 🔴 critical |
| Max Client Connections | 9,000 | 3,700 | -58.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% lower than advertised
- Egress Throughput: Config is 33.3% lower than advertised
- Max Partitions: Config is 209.9% higher than advertised
- Max Client Connections: Config is 58.9% lower than advertised

#### Tier 2 (im4gn.xlarge)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 47.7 Mbps | 31.8 Mbps | -33.3% | 🟠 major |
| Egress Throughput | 143.1 Mbps | 95.4 Mbps | -33.3% | 🟠 major |
| Max Partitions | 5,600 | 5,694 | +1.7% | 🟢 minor |
| Max Client Connections | 22,500 | 9,100 | -59.6% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% lower than advertised
- Egress Throughput: Config is 33.3% lower than advertised
- Max Client Connections: Config is 59.6% lower than advertised

#### Tier 2 (m7gd.xlarge)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 47.7 Mbps | 63.6 Mbps | +33.3% | 🟠 major |
| Egress Throughput | 143.1 Mbps | 190.7 Mbps | +33.3% | 🟠 major |
| Max Partitions | 5,600 | 5,694 | +1.7% | 🟢 minor |
| Max Client Connections | 22,500 | 9,100 | -59.6% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% higher than advertised
- Egress Throughput: Config is 33.3% higher than advertised
- Max Client Connections: Config is 59.6% lower than advertised

#### Tier 2 - x86 (i3en.xlarge)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 47.7 Mbps | 31.8 Mbps | -33.3% | 🟠 major |
| Egress Throughput | 143.1 Mbps | 95.4 Mbps | -33.3% | 🟠 major |
| Max Partitions | 5,600 | 5,694 | +1.7% | 🟢 minor |
| Max Client Connections | 22,500 | 9,100 | -59.6% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% lower than advertised
- Egress Throughput: Config is 33.3% lower than advertised
- Max Client Connections: Config is 59.6% lower than advertised

#### Tier 3 (im4gn.xlarge)

**Configuration**: 6 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 95.4 Mbps | 31.8 Mbps | -66.7% | 🔴 critical |
| Egress Throughput | 190.7 Mbps | 63.6 Mbps | -66.7% | 🔴 critical |
| Max Partitions | 11,200 | 11,340 | +1.3% | 🟢 minor |
| Max Client Connections | 45,000 | 9,100 | -79.8% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 66.7% lower than advertised
- Egress Throughput: Config is 66.7% lower than advertised
- Max Client Connections: Config is 79.8% lower than advertised

#### Tier 3 (m7gd.xlarge)

**Configuration**: 6 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 95.4 Mbps | 63.6 Mbps | -33.3% | 🟠 major |
| Egress Throughput | 190.7 Mbps | 190.7 Mbps | 0.0% | 🟢 minor |
| Max Partitions | 11,200 | 11,340 | +1.3% | 🟢 minor |
| Max Client Connections | 45,000 | 9,100 | -79.8% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% lower than advertised
- Max Client Connections: Config is 79.8% lower than advertised

#### Tier 3 - x86 (i3en.xlarge)

**Configuration**: 6 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 95.4 Mbps | 31.8 Mbps | -66.7% | 🔴 critical |
| Egress Throughput | 190.7 Mbps | 63.6 Mbps | -66.7% | 🔴 critical |
| Max Partitions | 11,200 | 11,340 | +1.3% | 🟢 minor |
| Max Client Connections | 45,000 | 9,100 | -79.8% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 66.7% lower than advertised
- Egress Throughput: Config is 66.7% lower than advertised
- Max Client Connections: Config is 79.8% lower than advertised

#### Tier 4 (im4gn.xlarge)

**Configuration**: 12 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 190.7 Mbps | 31.8 Mbps | -83.3% | 🔴 critical |
| Egress Throughput | 381.5 Mbps | 63.6 Mbps | -83.3% | 🔴 critical |
| Max Partitions | 22,600 | 22,836 | +1.0% | 🟢 minor |
| Max Client Connections | 90,000 | 9,100 | -89.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 83.3% lower than advertised
- Egress Throughput: Config is 83.3% lower than advertised
- Max Client Connections: Config is 89.9% lower than advertised

#### Tier 4 (m7gd.xlarge)

**Configuration**: 12 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 190.7 Mbps | 63.6 Mbps | -66.7% | 🔴 critical |
| Egress Throughput | 381.5 Mbps | 190.7 Mbps | -50.0% | 🟠 major |
| Max Partitions | 22,600 | 22,836 | +1.0% | 🟢 minor |
| Max Client Connections | 90,000 | 9,100 | -89.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 66.7% lower than advertised
- Egress Throughput: Config is 50.0% lower than advertised
- Max Client Connections: Config is 89.9% lower than advertised

#### Tier 4 - x86 (i3en.xlarge)

**Configuration**: 12 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 190.7 Mbps | 31.8 Mbps | -83.3% | 🔴 critical |
| Egress Throughput | 381.5 Mbps | 63.6 Mbps | -83.3% | 🔴 critical |
| Max Partitions | 22,600 | 22,836 | +1.0% | 🟢 minor |
| Max Client Connections | 90,000 | 9,100 | -89.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 83.3% lower than advertised
- Egress Throughput: Config is 83.3% lower than advertised
- Max Client Connections: Config is 89.9% lower than advertised

#### Tier 5 (im4gn.8xlarge)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 381.5 Mbps | 254.3 Mbps | -33.3% | 🟠 major |
| Egress Throughput | 762.9 Mbps | 508.6 Mbps | -33.3% | 🟠 major |
| Max Partitions | 45,600 | 4,455 | -90.2% | 🔴 critical |
| Max Client Connections | 180,000 | 72,100 | -59.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% lower than advertised
- Egress Throughput: Config is 33.3% lower than advertised
- Max Partitions: Config is 90.2% lower than advertised
- Max Client Connections: Config is 59.9% lower than advertised

#### Tier 5 (m7gd.8xlarge)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 381.5 Mbps | 508.6 Mbps | +33.3% | 🟠 major |
| Egress Throughput | 762.9 Mbps | 1525.9 Mbps | +100.0% | 🔴 critical |
| Max Partitions | 45,600 | 4,602 | -89.9% | 🔴 critical |
| Max Client Connections | 180,000 | 72,100 | -59.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% higher than advertised
- Egress Throughput: Config is 100.0% higher than advertised
- Max Partitions: Config is 89.9% lower than advertised
- Max Client Connections: Config is 59.9% lower than advertised

#### Tier 5 - x86 (i3en.6xlarge)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 381.5 Mbps | 254.3 Mbps | -33.3% | 🟠 major |
| Egress Throughput | 762.9 Mbps | 508.6 Mbps | -33.3% | 🟠 major |
| Max Partitions | 45,600 | 5,991 | -86.9% | 🔴 critical |
| Max Client Connections | 180,000 | 72,100 | -59.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% lower than advertised
- Egress Throughput: Config is 33.3% lower than advertised
- Max Partitions: Config is 86.9% lower than advertised
- Max Client Connections: Config is 59.9% lower than advertised

#### Tier 6 (im4gn.8xlarge)

**Configuration**: 6 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 762.9 Mbps | 254.3 Mbps | -66.7% | 🔴 critical |
| Egress Throughput | 1525.9 Mbps | 508.6 Mbps | -66.7% | 🔴 critical |
| Max Partitions | 90,000 | 8,784 | -90.2% | 🔴 critical |
| Max Client Connections | 180,000 | 36,100 | -79.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 66.7% lower than advertised
- Egress Throughput: Config is 66.7% lower than advertised
- Max Partitions: Config is 90.2% lower than advertised
- Max Client Connections: Config is 79.9% lower than advertised

#### Tier 6 (m7gd.8xlarge)

**Configuration**: 6 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 762.9 Mbps | 508.6 Mbps | -33.3% | 🟠 major |
| Egress Throughput | 1525.9 Mbps | 1525.9 Mbps | 0.0% | 🟢 minor |
| Max Partitions | 90,000 | 9,072 | -89.9% | 🔴 critical |
| Max Client Connections | 180,000 | 36,100 | -79.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% lower than advertised
- Max Partitions: Config is 89.9% lower than advertised
- Max Client Connections: Config is 79.9% lower than advertised

#### Tier 6 - x86 (i3en.6xlarge)

**Configuration**: 6 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 762.9 Mbps | 254.3 Mbps | -66.7% | 🔴 critical |
| Egress Throughput | 1525.9 Mbps | 508.6 Mbps | -66.7% | 🔴 critical |
| Max Partitions | 90,000 | 11,814 | -86.9% | 🔴 critical |
| Max Client Connections | 180,000 | 36,100 | -79.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 66.7% lower than advertised
- Egress Throughput: Config is 66.7% lower than advertised
- Max Partitions: Config is 86.9% lower than advertised
- Max Client Connections: Config is 79.9% lower than advertised

#### Tier 7 (im4gn.8xlarge)

**Configuration**: 9 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 1144.4 Mbps | 254.3 Mbps | -77.8% | 🔴 critical |
| Egress Throughput | 2288.8 Mbps | 508.6 Mbps | -77.8% | 🔴 critical |
| Max Partitions | 112,500 | 10,989 | -90.2% | 🔴 critical |
| Max Client Connections | 270,000 | 36,100 | -86.6% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 77.8% lower than advertised
- Egress Throughput: Config is 77.8% lower than advertised
- Max Partitions: Config is 90.2% lower than advertised
- Max Client Connections: Config is 86.6% lower than advertised

#### Tier 7 (m7gd.8xlarge)

**Configuration**: 9 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 1144.4 Mbps | 508.6 Mbps | -55.6% | 🔴 critical |
| Egress Throughput | 2288.8 Mbps | 1525.9 Mbps | -33.3% | 🟠 major |
| Max Partitions | 112,500 | 11,358 | -89.9% | 🔴 critical |
| Max Client Connections | 270,000 | 36,100 | -86.6% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 55.6% lower than advertised
- Egress Throughput: Config is 33.3% lower than advertised
- Max Partitions: Config is 89.9% lower than advertised
- Max Client Connections: Config is 86.6% lower than advertised

#### Tier 7 - x86 (i3en.6xlarge)

**Configuration**: 9 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 1144.4 Mbps | 254.3 Mbps | -77.8% | 🔴 critical |
| Egress Throughput | 2288.8 Mbps | 508.6 Mbps | -77.8% | 🔴 critical |
| Max Partitions | 112,500 | 14,778 | -86.9% | 🔴 critical |
| Max Client Connections | 270,000 | 36,100 | -86.6% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 77.8% lower than advertised
- Egress Throughput: Config is 77.8% lower than advertised
- Max Partitions: Config is 86.9% lower than advertised
- Max Client Connections: Config is 86.6% lower than advertised

#### Tier 8 (im4gn.8xlarge)

**Configuration**: 12 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 1525.9 Mbps | 254.3 Mbps | -83.3% | 🔴 critical |
| Egress Throughput | 3051.8 Mbps | 508.6 Mbps | -83.3% | 🔴 critical |
| Max Partitions | 112,500 | 11,028 | -90.2% | 🔴 critical |
| Max Client Connections | 360,000 | 36,100 | -90.0% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 83.3% lower than advertised
- Egress Throughput: Config is 83.3% lower than advertised
- Max Partitions: Config is 90.2% lower than advertised
- Max Client Connections: Config is 90.0% lower than advertised

#### Tier 8 (m7gd.8xlarge)

**Configuration**: 12 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 1525.9 Mbps | 508.6 Mbps | -66.7% | 🔴 critical |
| Egress Throughput | 3051.8 Mbps | 1525.9 Mbps | -50.0% | 🟠 major |
| Max Partitions | 112,500 | 11,388 | -89.9% | 🔴 critical |
| Max Client Connections | 360,000 | 36,100 | -90.0% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 66.7% lower than advertised
- Egress Throughput: Config is 50.0% lower than advertised
- Max Partitions: Config is 89.9% lower than advertised
- Max Client Connections: Config is 90.0% lower than advertised

#### Tier 8 - x86 (i3en.6xlarge)

**Configuration**: 12 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 1525.9 Mbps | 254.3 Mbps | -83.3% | 🔴 critical |
| Egress Throughput | 3051.8 Mbps | 508.6 Mbps | -83.3% | 🔴 critical |
| Max Partitions | 112,500 | 14,820 | -86.8% | 🔴 critical |
| Max Client Connections | 360,000 | 36,100 | -90.0% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 83.3% lower than advertised
- Egress Throughput: Config is 83.3% lower than advertised
- Max Partitions: Config is 86.8% lower than advertised
- Max Client Connections: Config is 90.0% lower than advertised

#### Tier 9 (im4gn.8xlarge)

**Configuration**: 15 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 1907.3 Mbps | 254.3 Mbps | -86.7% | 🔴 critical |
| Egress Throughput | 3814.7 Mbps | 508.6 Mbps | -86.7% | 🔴 critical |
| Max Partitions | 112,500 | 11,055 | -90.2% | 🔴 critical |
| Max Client Connections | 450,000 | 36,100 | -92.0% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 86.7% lower than advertised
- Egress Throughput: Config is 86.7% lower than advertised
- Max Partitions: Config is 90.2% lower than advertised
- Max Client Connections: Config is 92.0% lower than advertised

#### Tier 9 (m7gd.8xlarge)

**Configuration**: 15 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 1907.3 Mbps | 508.6 Mbps | -73.3% | 🔴 critical |
| Egress Throughput | 3814.7 Mbps | 1525.9 Mbps | -60.0% | 🔴 critical |
| Max Partitions | 112,500 | 11,415 | -89.9% | 🔴 critical |
| Max Client Connections | 450,000 | 36,100 | -92.0% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 73.3% lower than advertised
- Egress Throughput: Config is 60.0% lower than advertised
- Max Partitions: Config is 89.9% lower than advertised
- Max Client Connections: Config is 92.0% lower than advertised

#### Tier 9 - x86 (i3en.6xlarge)

**Configuration**: 15 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 1907.3 Mbps | 254.3 Mbps | -86.7% | 🔴 critical |
| Egress Throughput | 3814.7 Mbps | 508.6 Mbps | -86.7% | 🔴 critical |
| Max Partitions | 112,500 | 14,850 | -86.8% | 🔴 critical |
| Max Client Connections | 450,000 | 36,100 | -92.0% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 86.7% lower than advertised
- Egress Throughput: Config is 86.7% lower than advertised
- Max Partitions: Config is 86.8% lower than advertised
- Max Client Connections: Config is 92.0% lower than advertised

### Azure

#### Tier 1 (x86 - Ddv5) (Standard_D2d_v5)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 19.1 Mbps | 31.8 Mbps | +66.7% | 🔴 critical |
| Egress Throughput | 57.2 Mbps | 95.4 Mbps | +66.7% | 🔴 critical |
| Max Partitions | 1,000 | 6,198 | +519.8% | 🔴 critical |
| Max Client Connections | 9,000 | 3,700 | -58.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 66.7% higher than advertised
- Egress Throughput: Config is 66.7% higher than advertised
- Max Partitions: Config is 519.8% higher than advertised
- Max Client Connections: Config is 58.9% lower than advertised

#### Tier 2 (x86 - Ddv5) (Standard_D4d_v5)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 47.7 Mbps | 63.6 Mbps | +33.3% | 🟠 major |
| Egress Throughput | 143.1 Mbps | 190.7 Mbps | +33.3% | 🟠 major |
| Max Partitions | 2,800 | 5,694 | +103.4% | 🔴 critical |
| Max Client Connections | 22,500 | 9,100 | -59.6% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% higher than advertised
- Egress Throughput: Config is 33.3% higher than advertised
- Max Partitions: Config is 103.4% higher than advertised
- Max Client Connections: Config is 59.6% lower than advertised

#### Tier 3 (x86 - Ddv5) (Standard_D4d_v5)

**Configuration**: 6 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 95.4 Mbps | 63.6 Mbps | -33.3% | 🟠 major |
| Egress Throughput | 190.7 Mbps | 190.7 Mbps | 0.0% | 🟢 minor |
| Max Partitions | 5,600 | 11,340 | +102.5% | 🔴 critical |
| Max Client Connections | 45,000 | 9,100 | -79.8% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% lower than advertised
- Max Partitions: Config is 102.5% higher than advertised
- Max Client Connections: Config is 79.8% lower than advertised

#### Tier 4 (x86 - Ddv5) (Standard_D4d_v5)

**Configuration**: 12 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 190.7 Mbps | 63.6 Mbps | -66.7% | 🔴 critical |
| Egress Throughput | 381.5 Mbps | 190.7 Mbps | -50.0% | 🟠 major |
| Max Partitions | 11,300 | 22,836 | +102.1% | 🔴 critical |
| Max Client Connections | 90,000 | 9,100 | -89.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 66.7% lower than advertised
- Egress Throughput: Config is 50.0% lower than advertised
- Max Partitions: Config is 102.1% higher than advertised
- Max Client Connections: Config is 89.9% lower than advertised

#### Tier 5 (x86 - Ddv5) (Standard_D32d_v5)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 381.5 Mbps | 508.6 Mbps | +33.3% | 🟠 major |
| Egress Throughput | 762.9 Mbps | 1525.9 Mbps | +100.0% | 🔴 critical |
| Max Partitions | 22,800 | 4,602 | -79.8% | 🔴 critical |
| Max Client Connections | 180,000 | 72,100 | -59.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% higher than advertised
- Egress Throughput: Config is 100.0% higher than advertised
- Max Partitions: Config is 79.8% lower than advertised
- Max Client Connections: Config is 59.9% lower than advertised

### GCP

#### Tier 1 (n2d-standard-2)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 19.1 Mbps | 31.8 Mbps | +66.7% | 🔴 critical |
| Egress Throughput | 57.2 Mbps | 95.4 Mbps | +66.7% | 🔴 critical |
| Max Partitions | 2,000 | 6,198 | +209.9% | 🔴 critical |
| Max Client Connections | 9,000 | 3,700 | -58.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 66.7% higher than advertised
- Egress Throughput: Config is 66.7% higher than advertised
- Max Partitions: Config is 209.9% higher than advertised
- Max Client Connections: Config is 58.9% lower than advertised

#### Tier 2 (n2d-standard-4)

**Configuration**: 3 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 47.7 Mbps | 63.6 Mbps | +33.3% | 🟠 major |
| Egress Throughput | 143.1 Mbps | 190.7 Mbps | +33.3% | 🟠 major |
| Max Partitions | 5,600 | 5,694 | +1.7% | 🟢 minor |
| Max Client Connections | 22,500 | 9,100 | -59.6% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% higher than advertised
- Egress Throughput: Config is 33.3% higher than advertised
- Max Client Connections: Config is 59.6% lower than advertised

#### Tier 3 (n2d-standard-4)

**Configuration**: 6 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 95.4 Mbps | 63.6 Mbps | -33.3% | 🟠 major |
| Egress Throughput | 190.7 Mbps | 190.7 Mbps | 0.0% | 🟢 minor |
| Max Partitions | 11,200 | 11,340 | +1.3% | 🟢 minor |
| Max Client Connections | 45,000 | 9,100 | -79.8% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% lower than advertised
- Max Client Connections: Config is 79.8% lower than advertised

#### Tier 4 (n2d-standard-4)

**Configuration**: 12 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 190.7 Mbps | 63.6 Mbps | -66.7% | 🔴 critical |
| Egress Throughput | 381.5 Mbps | 190.7 Mbps | -50.0% | 🟠 major |
| Max Partitions | 22,600 | 22,836 | +1.0% | 🟢 minor |
| Max Client Connections | 90,000 | 9,100 | -89.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 66.7% lower than advertised
- Egress Throughput: Config is 50.0% lower than advertised
- Max Client Connections: Config is 89.9% lower than advertised

#### Tier 5 (n2d-standard-16)

**Configuration**: 6 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 381.5 Mbps | 254.3 Mbps | -33.3% | 🟠 major |
| Egress Throughput | 762.9 Mbps | 762.9 Mbps | 0.0% | 🟢 minor |
| Max Partitions | 45,600 | 9,204 | -79.8% | 🔴 critical |
| Max Client Connections | 180,000 | 36,100 | -79.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 33.3% lower than advertised
- Max Partitions: Config is 79.8% lower than advertised
- Max Client Connections: Config is 79.9% lower than advertised

#### Tier 6 (n2d-standard-16)

**Configuration**: 12 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 762.9 Mbps | 254.3 Mbps | -66.7% | 🔴 critical |
| Egress Throughput | 1525.9 Mbps | 762.9 Mbps | -50.0% | 🟠 major |
| Max Partitions | 90,000 | 18,144 | -79.8% | 🔴 critical |
| Max Client Connections | 180,000 | 18,100 | -89.9% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 66.7% lower than advertised
- Egress Throughput: Config is 50.0% lower than advertised
- Max Partitions: Config is 79.8% lower than advertised
- Max Client Connections: Config is 89.9% lower than advertised

#### Tier 7 (n2d-standard-16)

**Configuration**: 18 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 1144.4 Mbps | 254.3 Mbps | -77.8% | 🔴 critical |
| Egress Throughput | 2288.8 Mbps | 762.9 Mbps | -66.7% | 🔴 critical |
| Max Partitions | 112,500 | 22,716 | -79.8% | 🔴 critical |
| Max Client Connections | 270,000 | 18,100 | -93.3% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 77.8% lower than advertised
- Egress Throughput: Config is 66.7% lower than advertised
- Max Partitions: Config is 79.8% lower than advertised
- Max Client Connections: Config is 93.3% lower than advertised

#### Tier 8 (n2d-standard-32)

**Configuration**: 12 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 1525.9 Mbps | 508.6 Mbps | -66.7% | 🔴 critical |
| Egress Throughput | 3051.8 Mbps | 1525.9 Mbps | -50.0% | 🟠 major |
| Max Partitions | 112,500 | 11,028 | -90.2% | 🔴 critical |
| Max Client Connections | 360,000 | 36,100 | -90.0% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 66.7% lower than advertised
- Egress Throughput: Config is 50.0% lower than advertised
- Max Partitions: Config is 90.2% lower than advertised
- Max Client Connections: Config is 90.0% lower than advertised

#### Tier 9 (n2d-standard-32)

**Configuration**: 15 nodes

| Metric | Advertised | Actual | Difference | Status |
|--------|------------|--------|------------|--------|
| Ingress Throughput | 1907.3 Mbps | 508.6 Mbps | -73.3% | 🔴 critical |
| Egress Throughput | 3814.7 Mbps | 1525.9 Mbps | -60.0% | 🔴 critical |
| Max Partitions | 112,500 | 11,055 | -90.2% | 🔴 critical |
| Max Client Connections | 450,000 | 36,100 | -92.0% | 🔴 critical |

**⚠️ Major Issues:**
- Ingress Throughput: Config is 73.3% lower than advertised
- Egress Throughput: Config is 60.0% lower than advertised
- Max Partitions: Config is 90.2% lower than advertised
- Max Client Connections: Config is 92.0% lower than advertised

## Recommendations

1. **🔴 Critical/Major Issues**: Immediate review required for tiers with >25% discrepancies
2. **📊 Throughput Alignment**: Standardize ingress/egress limits across machine types within tiers
3. **👥 Client Connection Review**: Many config limits are significantly lower than advertised
4. **📈 Partition Capacity**: Some tiers exceed advertised partition limits in config
5. **🔄 Regular Audits**: Implement automated checks to prevent future discrepancies

