export interface Span {
    id: string;
    name: string;
    start_time: number;
    end_time: number;
    duration: number;
    num_debug_logs?: number;
    num_info_logs?: number;
    num_warning_logs?: number;
    num_error_logs?: number;
    num_critical_logs?: number;
    spans?: Span[]; // Optional nested spans
    telemetry_sdk_language?: string;
}

export interface Trace {
    id: string;
    service_name?: string;
    service_environment?: string;
    num_debug_logs?: number;
    num_info_logs?: number;
    num_warning_logs?: number;
    num_error_logs?: number;
    num_critical_logs?: number;
    duration: number;
    start_time: number;
    end_time: number;
    percentile: string;
    spans: Span[];
    telemetry_sdk_language: string[];
}

// Response type for the API
export interface TraceResponse {
    success: boolean;
    data: Trace[];
    error?: string;
}
