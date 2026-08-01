import { estAtteinte, type Etagere, type EtatDeLecture } from './atteinte';
import type { TypeOeuvre } from '../catalog/sources/types';

/**
 * Ce qu'un contenant entraîne, et rien d'autre.
 *
 * Deux règles pures vivent ici, pour la même raison qu'`atteinte.ts` existe :
 * elles sont consultées depuis trois endroits — la planification des cascades
 * dans `entries.ts`, leur exécution dans `cascade.ts`, et les tests — et trois
 * réimplémentations finiraient par se contredire.
 *
 * Aucune dépendance à la base : ce module s'importe de n'importe où.
 */

/**
 * R11 — les seuls types d'œuvre dont la consignation cascade vers le contenu.
 *
 * Le recueil et la saison de série télévisée, jamais la série de comics. Une
 * série est ouverte : son nombre de numéros n'est pas fini, et cascader
 * dessus consignerait des centaines de numéros **plus ceux qui n'existent pas
 * encore** — chaque parution ajouterait silencieusement une consignation que
 * le membre n'a pas faite.
 *
 * La liste est blanche et non noire, exactement comme les chemins publics de
 * `hooks.server.ts` : un type d'œuvre ajouté plus tard ne cascade pas tant que
 * quelqu'un ne l'a pas décidé, ce qui est le bon défaut.
 */
export const TYPES_CONTENANTS = ['recueil', 'saison'] as const satisfies readonly TypeOeuvre[];
export type TypeContenant = (typeof TYPES_CONTENANTS)[number];

/** R11 — la consignation de cette œuvre cascade-t-elle vers son contenu ? */
export function cascadeDescendante(type: TypeOeuvre): type is TypeContenant {
	return (TYPES_CONTENANTS as readonly TypeOeuvre[]).includes(type);
}

/**
 * L'ordre d'avancement des étagères, pour départager plusieurs recueils.
 *
 * Un numéro appartient couramment à plusieurs recueils, et rien n'oblige un
 * membre à les lire au même rythme : l'omnibus est terminé, l'intégrale qui
 * reprend les mêmes numéros est en cours. Il faut donc une règle, et
 * « la dernière propagation l'emporte » n'en est pas une acceptable — elle
 * ferait *perdre* son atteinte à un numéro déjà lu parce qu'on vient d'ouvrir
 * un second recueil qui le contient, avec pour conséquence un ordre qui
 * recule, un avis qui se re-masque et des arêtes de graphe qui disparaissent.
 *
 * L'état retenu est donc **le plus avancé**, ce qui rend le résultat
 * indépendant de l'ordre de traitement des lots — propriété dont dépend
 * directement l'idempotence de la cascade fractionnée.
 */
const RANG_ETAGERE: Record<Etagere, number> = { a_decouvrir: 0, en_cours: 1, termine: 2 };

function avancement(etat: EtatDeLecture): number {
	// L'atteinte prime sur l'étagère : une œuvre abandonnée en cours de route est
	// plus avancée qu'une œuvre encore en cours, parce que R3 la dit atteinte.
	return (estAtteinte(etat) ? 10 : 0) + RANG_ETAGERE[etat.etagere];
}

/**
 * Le plus avancé d'un ensemble d'états, ou `null` s'il est vide.
 *
 * À égalité d'avancement, le premier l'emporte : les états à égalité sont
 * équivalents pour tout ce qui dépend de la frontière « atteint », et se donner
 * un départage arbitraire de plus n'apporterait rien.
 */
export function etatLePlusAvance(etats: EtatDeLecture[]): EtatDeLecture | null {
	let meilleur: EtatDeLecture | null = null;
	for (const etat of etats) {
		if (meilleur === null || avancement(etat) > avancement(meilleur)) meilleur = etat;
	}
	return meilleur;
}
