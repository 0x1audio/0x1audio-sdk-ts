// Every failure from the Mixel clients (the cloud, and the Mixel on this computer) is a MixelError
// with a stable `code`, a sentence for a person (`message`) and, when there is one, the next step
// (`fix`). Branch on the class or on `code`, never on the message.
//
//   MixelError               Mixel or the cloud refused: bad_input, unknown_id, crates_off, …
//   ├ MixelApiError          the cloud answered with an error status: also `status`, `param`, `docUrl`
//   ├ MixelUnavailableError  nothing answered: Mixel is closed, a switch is off, or no network
//   └ MixelTimeoutError      it answered too slowly, after the retries
//
// JSON.stringify(error) is {code, message, fix}: small enough to hand to a model as it is.

export class MixelError extends Error {
  readonly code: string
  readonly fix?: string
  constructor(code: string, message: string, fix?: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "MixelError"
    this.code = code
    if (fix) this.fix = fix
  }

  toJSON(): { code: string; message: string; fix?: string } {
    return { code: this.code, message: this.message, ...(this.fix ? { fix: this.fix } : {}) }
  }
}

export class MixelUnavailableError extends MixelError {
  constructor(code: string, message: string, fix?: string, options?: { cause?: unknown }) {
    super(code, message, fix, options)
    this.name = "MixelUnavailableError"
  }
}

export class MixelTimeoutError extends MixelError {
  constructor(message: string, fix?: string, options?: { cause?: unknown }) {
    super("timeout", message, fix, options)
    this.name = "MixelTimeoutError"
  }
}

// One problem in a refusal the command line prints, like a manifest error.
export interface ProblemDetail {
  code: string
  message: string
  fix?: string
  param?: string
  doc_url?: string
}

export class MixelApiError extends MixelError {
  readonly status: number
  readonly param?: string
  readonly docUrl?: string
  // Every problem, when the cloud found more than one (a submission's app.json).
  readonly errors: ProblemDetail[]
  // The body as the cloud sent it, so code written against { error } keeps working.
  readonly error: ProblemDetail
  constructor(status: number, detail: ProblemDetail, errors: ProblemDetail[] = []) {
    super(detail.code, detail.message, detail.fix)
    this.name = "MixelApiError"
    this.status = status
    this.error = detail
    this.errors = errors
    if (detail.param) this.param = detail.param
    if (detail.doc_url) this.docUrl = detail.doc_url
  }

  toJSON() {
    return { ...super.toJSON(), status: this.status, ...(this.param ? { param: this.param } : {}), ...(this.docUrl ? { doc_url: this.docUrl } : {}) }
  }
}
