import { getDb } from '../src/lib/server/db';
import { deroulerCascades, rattraperCascades } from '../src/lib/server/journal/cascade';

/**
 * Le Worker planifié : le seul ordonnanceur du palier gratuit de Cloudflare.
 *
 * **Pourquoi un Worker séparé, et pas un handler `scheduled` dans celui de
 * l'application.** `@sveltejs/adapter-cloudflare` écrit lui-même le fichier
 * désigné par `main` dans la configuration Wrangler — il l'efface puis le
 * remplace par son propre `_worker.js`, qui n'exporte que `fetch`. Y greffer un
 * handler `scheduled` demanderait de réécrire du code généré après chaque build,
 * ce qui casserait silencieusement à la première montée de version de
 * l'adaptateur. Deux Workers partageant la même base D1 coûtent une commande de
 * déploiement de plus et rien d'autre — voir `wrangler.cron.jsonc`.
 *
 * **Ce qu'il fait, et pourquoi ça ne peut pas être fait ailleurs.** Un handler
 * `fetch` du palier gratuit dispose de 10 ms de temps processeur ; un handler
 * planifié en a bien davantage. Tout ce qui est trop long pour une requête vit
 * donc ici : la reprise des cascades fractionnées de U5 d'abord, et plus tard la
 * matérialisation du graphe de U9 et le rejeu des ingestions partielles de U3.
 *
 * **L'ordre des deux appels n'est pas indifférent.** Le rattrapage replanifie
 * les cascades qu'un contenu résolu après coup a rendues incomplètes ; le
 * déroulement les exécute. Rattraper d'abord fait traiter le nouveau travail dès
 * ce passage-ci plutôt qu'au suivant.
 */
export default {
	async scheduled(_event: ScheduledController, env: { DB: D1Database }): Promise<void> {
		const db = getDb(env.DB);

		await rattraperCascades(db);
		await deroulerCascades(db);
	}
};
