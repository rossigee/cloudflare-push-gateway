.PHONY: vault-secrets config-cloudflare build deploy test ci

VAULT_PATH=infrastructure/push-gateway
CLOUDFLARE_ACCOUNT_ID=c1b74f148aee28025816e104a92622c5

vault-secrets:
	@echo "Writing secrets to Vault at $(VAULT_PATH)..."
	vault kv put $(VAULT_PATH) \
		pushgateway_auth_user=admin \
		pushgateway_auth_pass=67YzxYezCUoCBgDJ8wt \
		api_tokens=6Eli9kMFYwByglE
	@echo "Secrets written to Vault"

config-cloudflare:
	@echo "Fetching secrets from Vault..."
	@PUSHGATEWAY_AUTH_USER="$$(vault kv get -field=pushgateway_auth_user $(VAULT_PATH))" && \
	PUSHGATEWAY_AUTH_PASS="$$(vault kv get -field=pushgateway_auth_pass $(VAULT_PATH))" && \
	API_TOKENS="$$(vault kv get -field=api_tokens $(VAULT_PATH))" && \
	JWT_ISSUER="$$(vault kv get -field=jwt_issuer $(VAULT_PATH))" && \
	JWT_AUDIENCE="$$(vault kv get -field=jwt_audience $(VAULT_PATH))" && \
	JWKS_URI="$$(vault kv get -field=jwks_uri $(VAULT_PATH))" && \
	KEYCLOAK_CLIENT_SECRET="$$(vault kv get -field=keycloak_client_secret $(VAULT_PATH))" && \
	BASE_URL="$$(vault kv get -field=base_url $(VAULT_PATH))" && \
	echo "Setting Cloudflare secrets..." && \
	echo "$$PUSHGATEWAY_AUTH_USER" | npx wrangler secret put PUSHGATEWAY_AUTH_USER --env="" && \
	echo "$$PUSHGATEWAY_AUTH_PASS" | npx wrangler secret put PUSHGATEWAY_AUTH_PASS --env="" && \
	echo "$$API_TOKENS" | npx wrangler secret put API_TOKENS --env="" && \
	echo "$$JWT_ISSUER" | npx wrangler secret put JWT_ISSUER --env="" && \
	echo "$$JWT_AUDIENCE" | npx wrangler secret put JWT_AUDIENCE --env="" && \
	echo "$$JWKS_URI" | npx wrangler secret put JWKS_URI --env="" && \
	echo "$$KEYCLOAK_CLIENT_SECRET" | npx wrangler secret put KEYCLOAK_CLIENT_SECRET --env="" && \
	echo "$$BASE_URL" | npx wrangler secret put BASE_URL --env="" && \
	echo "Cloudflare secrets configured"

build:
	npm run build

deploy:
	npm run deploy

test:
	npm run test

ci:
	npm ci
	npm run typecheck
	npm test
	npm run build
