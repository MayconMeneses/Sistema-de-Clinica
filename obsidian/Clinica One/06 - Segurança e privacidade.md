---
tags: [seguranca, lgpd]
projeto: Clínica One
atualizado: 2026-10-07
---


# Segurança e privacidade

Volta: [[00 - Índice]] · [[Documentos do repositório/Modelo de ameaças]].

## Controles implementados e testados
- Sessão no servidor (token de 256 bits, guardado como hash), cookie HttpOnly + SameSite=Strict, CSP sem inline, cabeçalho anti-CSRF + checagem de Origin.
- Senhas com scrypt; login com resposta genérica e tempo equalizado; **limite de tentativas no PostgreSQL**.
- **MFA (TOTP)** no Master e opcional na clínica; código de **uso único**; segredo **cifrado** (AES-256-GCM).
- RBAC deny-by-default + entitlements decididos no servidor; Master sem acesso a dados clínicos.
- Logs **sem dados de paciente** (query string nunca é registrada); erros sem stack/SQL.
- Auditoria durável: leitura de prontuário/odontograma, exportações, mesclagens, mudanças de plano.
- Webhooks: assinatura HMAC, janela anti-replay, deduplicação.

## Privacidade (ferramentas, **não** conformidade)
Consentimento versionado por canal · exportação dos dados do paciente (respeita permissões, auditada) · solicitações do titular com prazo de referência de 15 dias · mesclagem sem apagar histórico · minimização em logs e filas.
**Faltam**: base legal por finalidade, retenção/descarte, anonimização, incidentes, RIPD, suboperadores, textos jurídicos. Exige revisão humana especializada.

## Riscos conhecidos
Chave de cifragem sem rotação/KMS · sem recuperação de senha por e-mail · HTTPS e gestão de segredos dependem do deploy · sem pentest/SAST · fuso fixo em São Paulo.
