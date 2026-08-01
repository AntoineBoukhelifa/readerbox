import { getDb } from '../src/lib/server/db';
import { deroulerCascades, rattraperCascades } from '../src/lib/server/journal/cascade';
import { deroulerGraphe, rattraperGraphe } from '../src/lib/server/graph/rematerialize';

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
 * donc ici : la reprise des cascades fractionnées de U5, la matérialisation du
 * graphe de U9, et plus tard le rejeu des ingestions partielles de U3.
 *
 * **L'ordre des quatre appels n'est pas indifférent.**
 *
 * 1. `rattraperCascades` replanifie les cascades qu'un contenu résolu après coup
 *    a rendues incomplètes ;
 * 2. `deroulerCascades` les exécute — et c'est lui qui produit le gros des
 *    franchissements de frontière : terminer un omnibus de quarante numéros en
 *    enfile quarante ;
 * 3. `deroulerGraphe` consomme les deux files de U9, celle des franchissements
 *    et celle des rattachements modifiés. Le faire après les cascades traite le
 *    travail qu'elles viennent de produire dès ce passage-ci plutôt qu'au
 *    suivant ;
 * 4. `rattraperGraphe` balaie, borné, les appuis restés en place alors que
 *    l'œuvre n'est plus atteinte — la seule divergence que les files ne peuvent
 *    pas rattraper d'elles-mêmes, et la seule qui puisse laisser voir une arête
 *    que R52 interdit.
 */
export default {
	async scheduled(_event: ScheduledController, env: { DB: D1Database }): Promise<void> {
		const db = getDb(env.DB);

		await rattraperCascades(db);
		await deroulerCascades(db);
		await deroulerGraphe(db);
		await rattraperGraphe(db);
	}
};
