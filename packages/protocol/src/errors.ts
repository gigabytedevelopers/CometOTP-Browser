/** Why something received from another party, or given by a caller, was refused. */
export type ProtocolErrorCode =
  | 'bad_encoding'
  | 'bad_uri'
  | 'unsupported_version'
  | 'bad_relay'
  | 'bad_public_key'
  | 'auth_failed'
  | 'bad_message'
  | 'bad_blob'
  | 'rollback'
  | 'bad_payload';

export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}
