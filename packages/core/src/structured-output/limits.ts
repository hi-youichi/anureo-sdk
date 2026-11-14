// Defines output-policy budget inputs. Resource admission sites own defaults, validation and reservations.
import type { QueueLimits } from '../queue'

/**
 * Client passes these internal queue/result settings through withStructuredOutput to each
 * OutputSession. Client validates scalar retention limits during construction; queue settings are
 * consumed separately by their resource owners. Optional values select admission-site defaults.
 * This type acquires no resources. The wrapper and session own accounting and overflow failures.
 */
export interface OutputLimits {
  /**
   * Queued plus held output events: maxEvents defaults to 2048 and maxBytes to 16 MiB.
   * maxFrameBytes defaults to 8 MiB, also bounding transformed requests and bridge bodies.
   * Other QueueLimits fields are unused by output policy.
   */
  queue?: QueueLimits
  /** Count cap for retained output submissions and terminal-version replay markers; defaults to 1024. */
  maxSubmissions?: number
  /** Session-wide serialized UTF-8 retention and per-candidate byte cap; defaults to 16 MiB. */
  maxResultBytes?: number
  /** Distinct text-bearing item cap within each structured submission; defaults to 2048. */
  maxItems?: number
}
