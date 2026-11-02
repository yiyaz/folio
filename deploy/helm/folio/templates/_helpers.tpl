{{- define "folio.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "folio.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "folio.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "folio.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "folio.selectorLabels" -}}
app.kubernetes.io/name: {{ include "folio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "folio.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "folio.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "folio.secretName" -}}
{{- default (printf "%s-secrets" (include "folio.fullname" .)) .Values.existingSecret -}}
{{- end -}}

{{- define "folio.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{/* Reuse an existing generated value across upgrades, else generate one. */}}
{{- define "folio.generated" -}}
{{- $secret := lookup "v1" "Secret" .ctx.Release.Namespace .secret -}}
{{- if and $secret (index $secret.data .key) -}}
{{- index $secret.data .key | b64dec -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}

{{- define "folio.pgPassword" -}}
{{- default (include "folio.generated" (dict "ctx" . "secret" (printf "%s-postgresql" (include "folio.fullname" .)) "key" "password")) .Values.postgresql.password -}}
{{- end -}}

{{/* Environment shared by the app container and the migration initContainer. */}}
{{- define "folio.env" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef: { name: {{ include "folio.secretName" . }}, key: DATABASE_URL }
- name: APP_SECRET
  valueFrom:
    secretKeyRef: { name: {{ include "folio.secretName" . }}, key: APP_SECRET }
{{- end -}}
