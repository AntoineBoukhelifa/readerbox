/**
 * Le cache court des réponses de recherche.
 *
 * **Ce cache n'est pas la persistance du catalogue, et c'est tout l'intérêt.**
 * KTD1 veut qu'une œuvre ne soit écrite en base qu'au moment où un membre la
 * consigne ; il veut aussi que toute recherche interroge l'amont. Les deux
 * tiennent ensemble parce que ce qu'on garde ici est **l'appel**, pas l'œuvre :
 * rien n'entre au catalogue, et la fenêtre est assez courte pour qu'une donnée
 * corrigée chez la source réapparaisse en quelques minutes.
 *
 * Ce qu'il évite, mesuré : Metron étrangle vers la dizaine d'appels consécutifs.
 * Vingt membres derrière une clé unique, dont quatre explorent en parallèle un
 * soir, épuisent ce budget en quelques frappes — et la recherche devient
 * inutilisable pour tout le groupe, pas seulement pour eux. Un cache de deux
 * minutes suffit : c'est la durée pendant laquelle plusieurs personnes tapent la
 * même chose.
 *
 * **Seuls les succès sont gardés.** Mémoriser un échec ferait durer une panne
 * passagère au-delà d'elle-même ; le quota, lui, est déjà tenu par la veille de
 * l'adaptateur, qui sait jusqu'à quand la source a dit non.
 */

/** Deux minutes : le temps pendant lequel plusieurs membres tapent la même chose. */
export const DUREE_DE_CACHE_MS = 120_000;

/**
 * Le nombre d'entrées gardées.
 *
 * Un Worker n'a pas de mémoire à gaspiller et l'isolat peut vivre longtemps :
 * sans plafond, une soirée d'exploration ferait grossir la carte sans limite.
 * Deux cents recherches couvrent très largement ce qu'un groupe de vingt tape en
 * deux minutes.
 */
export const ENTREES_MAX = 200;

export interface CacheDeRecherche {
	lire<T>(cle: string): T | undefined;
	ecrire(cle: string, valeur: unknown): void;
	/** Vide le cache. Réservé aux tests et à un éventuel geste d'administration. */
	oublier(): void;
}

export interface OptionsDeCache {
	dureeMs?: number;
	entreesMax?: number;
	maintenant?: () => number;
}

export function creerCacheDeRecherche(options: OptionsDeCache = {}): CacheDeRecherche {
	const dureeMs = options.dureeMs ?? DUREE_DE_CACHE_MS;
	const entreesMax = options.entreesMax ?? ENTREES_MAX;
	const maintenant = options.maintenant ?? (() => Date.now());

	// Une `Map` conserve l'ordre d'insertion : la plus ancienne clé est la
	// première, ce qui donne l'éviction sans structure supplémentaire.
	const entrees = new Map<string, { valeur: unknown; expireA: number }>();

	return {
		lire<T>(cle: string): T | undefined {
			const entree = entrees.get(cle);
			if (entree === undefined) return undefined;

			if (entree.expireA <= maintenant()) {
				entrees.delete(cle);
				return undefined;
			}

			// La relecture rafraîchit le rang sans prolonger la durée de vie : une
			// recherche populaire reste en mémoire, mais elle ne devient jamais
			// périmée sans qu'on s'en aperçoive.
			entrees.delete(cle);
			entrees.set(cle, entree);
			return entree.valeur as T;
		},

		ecrire(cle: string, valeur: unknown): void {
			entrees.delete(cle);
			entrees.set(cle, { valeur, expireA: maintenant() + dureeMs });

			while (entrees.size > entreesMax) {
				const plusAncienne = entrees.keys().next();
				if (plusAncienne.done) break;
				entrees.delete(plusAncienne.value);
			}
		},

		oublier(): void {
			entrees.clear();
		}
	};
}

/**
 * Le cache du processus.
 *
 * Un module plutôt qu'un service injecté partout : sa portée est l'isolat, et
 * une instance par requête n'aurait aucun effet. Les tests, eux, en construisent
 * un à eux — c'est le rôle du paramètre `cache` de la couche de recherche.
 */
export const cacheDeRecherche = creerCacheDeRecherche();

/**
 * La clé d'une réponse mise en cache.
 *
 * Elle porte la source, parce que deux adaptateurs répondent différemment à la
 * même requête, et elle normalise la casse et les espaces : « immortal x-men »
 * et « Immortal  X-Men » sont la même recherche pour un membre, et payer deux
 * appels pour cette différence-là serait absurde.
 *
 * **Elle ne porte aucun identifiant de membre.** Une réponse de source est la
 * même pour tout le groupe ; c'est la fusion avec le local qui dépend du lecteur,
 * et elle a lieu après. Mettre le membre dans la clé diviserait l'efficacité du
 * cache par vingt, soit exactement le facteur qu'il existe pour absorber.
 */
export function cleDeRecherche(source: string, requete: string, suite?: string): string {
	const normalisee = requete.trim().toLowerCase().replace(/\s+/g, ' ');
	return `recherche\0${source}\0${normalisee}\0${suite ?? ''}`;
}

/** La clé d'un parcours par facette. Même règle, sur un identifiant qui n'est pas saisi. */
export function cleDeParcours(
	source: string,
	axe: string,
	idExterne: string,
	suite?: string
): string {
	return `parcours\0${source}\0${axe}\0${idExterne}\0${suite ?? ''}`;
}
