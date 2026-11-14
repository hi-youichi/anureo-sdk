// Defines output-policy budget inputs. Resource admission sites own defaults, validation and reservations.
import type { QueueLimits } from '../queue'

/**
 * Client passes event and retention budgets through withStructuredOutput to each OutputSession.
 * Client validates scalar retention limits during construction. The wrapper also uses the frame
 * budget when constructing the bridge manager. Omitted values use the consuming operation's defaults.
 */
export interface OutputLimits {
  /**
   * Queued plus held output events: maxEvents defaults to 2048 and maxBytes to 16 MiB.
   * maxFrameBytes defaults to 8 MiB per event, transformed request or bridge request body.
   */
  queue?: QueueLimits
  /** Separate count caps for retained output submissions and terminal-version markers, each defaulting to 1024. */
  maxSubmissions?: number
  /** Serialized UTF-8 byte limit for session-wide output retention and for each candidate, defaulting to 16 MiB. */
  maxResultBytes?: number
  /** Distinct text-bearing item cap within each structured submission, defaulting to 2048. */
  maxItems?: number
}
