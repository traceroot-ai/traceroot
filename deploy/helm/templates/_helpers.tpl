{{- define "traceroot.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "traceroot.labels" -}}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "traceroot.selectorLabels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "traceroot.clickhouse.hostname" -}}
{{- if .Values.clickhouse.deploy -}}
{{- printf "%s-clickhouse" (include "traceroot.fullname" .) -}}
{{- else -}}
{{- .Values.clickhouse.host -}}
{{- end -}}
{{- end }}
