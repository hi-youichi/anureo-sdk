// Defines output-policy budget inputs. Resource admission sites own defaults, validation and reservations.
import type { QueueLimits } from '../queue'

/**
 * Client passes these internal queue/result settings through withStructuredOutput to each
 * OutputSession. Client validates scalar retention limits during construction; queue settings are
 * consumed separately by their resource owners. Optional values select admission-site defaults.
 * This type acquires no resources. The wrapper and session own accounting and overflow failures.
 */
export interface OutputLimits {
  /** Event queue limits and transformed-request frame cap. maxFrameBytes also bounds bridge bodies. */
  queue?: QueueLimits
  /** Count cap for retained output submissions and terminal-version replay markers; defaults to 1024. */
  maxSubmissions?: number
  /** Session-wide retained output bytes and per-candidate size cap; defaults to 16 MiB. */
  maxResultBytes?: number
  /** Distinct text-bearing item cap within each structured submission; defaults to 2048. */
  maxItems?: number
}
