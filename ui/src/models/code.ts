export interface CodeResponse {
  line: string | null;
  lines_above: string[] | null;
  lines_below: string[] | null;
  error_message: string | null;
}
