import type { LayoutServerLoad } from './$types';

/**
 * Ce que la navigation persistante a besoin de savoir, et rien de plus.
 *
 * Le membre entier de `locals` n'est pas renvoyé : la barre n'a besoin que d'un
 * nom à afficher et d'un identifiant pour ouvrir le journal. Une charge utile
 * qui ne porte que ce qu'elle affiche est la même discipline que pour les
 * textes masqués — ce qui n'est pas envoyé ne peut pas fuir.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	return {
		membre: locals.member ? { id: locals.member.id, nom: locals.member.displayName } : null
	};
};
