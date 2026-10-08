-- 0024_payment_installments: parcelamento no cartão do link de pagamento. A clínica define o MÁXIMO de parcelas oferecido ao pagador;
-- o valor cobrado e o que cai no financeiro continuam sendo o valor da cobrança (taxas do parcelamento ficam com o provedor).
ALTER TABLE payment_intents ADD COLUMN max_installments smallint NOT NULL DEFAULT 1 CHECK (max_installments BETWEEN 1 AND 12);
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_installments_link CHECK (max_installments = 1 OR method = 'link');
