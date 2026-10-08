# Operação: chave de criptografia dos segredos

O sistema cifra em repouso (AES-256-GCM) os segredos de MFA (usuários e operadores) e as credenciais de pagamento. A chave é `DATA_ENCRYPTION_KEY` (32 bytes em base64). Cada valor guarda o **id da chave** que o cifrou (`v2:<id>:...`), então é possível provar quais valores ainda estão na chave antiga.

**Quando trocar:** a cada 12 meses (sugestão), quando alguém com acesso à chave sair da equipe, ou imediatamente se houver suspeita de vazamento (neste caso, siga também o `docs/juridico/PLANO-INCIDENTES.md`).

## Passo a passo (sem indisponibilidade)

0. **Backup do banco** antes de começar (`npm run drill` valida backup e restauração).
1. Gere a chave nova: `openssl rand -base64 32`. Guarde-a no cofre de segredos, **nunca no repositório**.
2. Configure o ambiente com as DUAS chaves e reinicie app e worker:
   ```
   DATA_ENCRYPTION_KEY=<chave nova>
   DATA_ENCRYPTION_KEY_PREVIOUS=<chave antiga>
   ```
   A partir daqui tudo novo é cifrado com a chave nova e o que está com a antiga continua legível.
3. Simule: `npm run rotate-key -- --dry-run` (mostra quantos segredos seriam recifrados; não grava nada).
4. Execute: `npm run rotate-key`. Cada valor é decifrado, recifrado e **conferido** antes de gravar. Se houver falha, o comando termina com erro e lista onde; nada fica pela metade (valores já trocados continuam legíveis).
5. Confirme: rode de novo `npm run rotate-key`; deve informar `recifrados: 0`.
6. Valores que ficam em **variáveis de ambiente** (ex.: `TELEGRAM_BOT_TOKEN_ENC`) não estão no banco: gere de novo com `echo -n "<token>" | npx tsx scripts/encrypt-secret.ts` usando a chave nova.
7. **Aposente a chave antiga**: remova `DATA_ENCRYPTION_KEY_PREVIOUS` e reinicie. Teste um login com MFA e uma consulta de pagamento. Mantenha a chave antiga arquivada no cofre pelo tempo de retenção dos backups feitos antes da troca (um backup antigo só abre com a chave antiga).

## Se algo der errado
- *"Valor cifrado com a chave X, que não está configurada"*: falta colocar a chave antiga em `DATA_ENCRYPTION_KEY_PREVIOUS`.
- Perda da chave sem cópia: os segredos de MFA e as credenciais de pagamento ficam irrecuperáveis. O MFA se refaz pela recuperação do Master; as credenciais de pagamento precisam ser digitadas de novo. Dados de pacientes **não** dependem desta chave.

## O que esta chave NÃO cobre
Dados clínicos e financeiros não são cifrados por campo com esta chave; a proteção deles é o controle de acesso, o isolamento no banco e a cifragem de disco/backup da hospedagem (a definir com o provedor).
