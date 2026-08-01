# 001 — Choix des sources de données

**Statut : en attente de mesure.** Les sondes sont écrites, les comptes ne sont pas créés.

Cette décision conditionne U3b, U9 et U10. Tant qu'elle n'est pas tranchée, aucun adaptateur ne doit être écrit — le but de U1 est justement d'éviter de construire sur une source qu'on aurait supposée bonne.

## Ce qui a déjà été établi

**L'API développeur Marvel n'existe plus.** Vérifié le 2026-08-01 par appel direct : `developer.marvel.com` redirige vers le site grand public, et `gateway.marvel.com` renvoie une erreur serveur là où une requête sans clé devrait être refusée avec un code dédié. Ce n'est pas une dégradation, c'est une disparition. La source la plus évidente pour un projet Marvel est hors jeu.

**TMDB répond correctement.** Vérifié le même jour : une requête non authentifiée reçoit un refus propre, ce qui est le comportement d'une API en bonne santé. C'est la source retenue pour les films, séries, saisons et épisodes, sauf surprise à la lecture des conditions.

**Metron et Comic Vine répondent.** Leurs conditions d'utilisation et leur qualité de données restent à vérifier, et c'est tout l'objet de ce document.

## Les cinq questions

Elles se mesurent avec `node scripts/sondes.js`, après avoir posé les clés dans l'environnement.

### 1. Licence

La licence autorise-t-elle de stocker les données dans une application privée, et de mettre en cache les visuels de couverture ? Quelles sont les obligations d'attribution exactes ?

| Source     | Licence   | Stockage autorisé | Couvertures | Attribution exigée |
| ---------- | --------- | ----------------- | ----------- | ------------------ |
| Metron     | à remplir |                   |             |                    |
| Comic Vine | à remplir |                   |             |                    |
| TMDB       | à remplir |                   |             |                    |

La question des couvertures n'est pas décorative : l'architecture retenue ne comporte pas de stockage d'objets, donc si la copie locale est exigée il faudra en ajouter un, et si elle est interdite il faudra pointer les URL des sources.

### 2. Débit

Les limites permettent-elles une recherche interactive **pour vingt membres derrière une clé unique** ? Et quel est le plafond de sous-requêtes par invocation, qui borne la taille d'une cascade de recueil ?

| Source     | Limite annoncée | Limite observée | En-têtes de quota | Latence max mesurée |
| ---------- | --------------- | --------------- | ----------------- | ------------------- |
| Metron     |                 |                 |                   |                     |
| Comic Vine |                 |                 |                   |                     |
| TMDB       |                 |                 |                   |                     |

### 3. Personnages par œuvre

Le champ dont dépend entièrement le graphe. Deux chiffres à relever : la proportion de numéros portant une liste exploitable, et le **nombre médian de crédits par numéro** — ce second chiffre borne le volume d'écriture de U9.

| Source     | 1960 | 1980 | 2000 | 2020 | Crédits, médiane |
| ---------- | ---- | ---- | ---- | ---- | ---------------- |
| Metron     |      |      |      |      |                  |
| Comic Vine |      |      |      |      |                  |

**Seuil de décision, fixé avant la mesure.** Sous **70 %** de couverture sur les numéros postérieurs à 2000, la dimension personnage du graphe est abandonnée : R49 passe de trois types de relation à deux, le graphe se réduit aux relations série et event, et U10 perd son filtre à trois dimensions. Cette forme dégradée est une variante nommée, pas une improvisation à décider en phase 3.

La lacune sur les décennies anciennes est une limite acceptée du projet, pas un défaut à corriger. On la mesure pour la connaître, pas pour la combler.

### 4. Composition des recueils

Quelle proportion de recueils et d'omnibus expose la liste des numéros qu'ils contiennent ? Toute l'unité U5 en dépend, et les bases modélisent les recueils différemment.

| Source     | Recueils testés | Contenu exposé | Format |
| ---------- | --------------- | -------------- | ------ |
| Metron     |                 |                |        |
| Comic Vine |                 |                |        |

Si aucune source ne l'expose de façon exploitable, la cascade de recueil devient déclarative — le membre saisit lui-même les numéros — ce qui change la nature de U5 et doit être décidé ici.

### 5. Parcours par facette

Chaque source expose-t-elle les apparitions d'un personnage, les œuvres d'une série, d'un créateur, d'un event ? KTD1 en fait un chemin amont, donc l'interface d'adaptateur doit le porter.

| Source     | Personnage | Série | Créateur | Event | Pagination |
| ---------- | ---------- | ----- | -------- | ----- | ---------- |
| Metron     |            |       |          |       |            |
| Comic Vine |            |       |          |       |            |
| TMDB       |            |       |          |       |            |

## Décision

_À écrire une fois les mesures faites._ Doit nommer :

- la source primaire pour les comics, et la source de complément
- la source pour l'audiovisuel
- la conclusion sur le seuil de 70 %, et donc la forme retenue du graphe
- la politique de couvertures
- ce qui se passe si une source ferme — le repli, et son coût

## Repli si aucune source ne convient

La Grand Comics Database publie des exports de base, pas une API de recherche. S'y replier **invalide KTD1** : on ne peut pas interroger l'amont en direct, donc il faut importer et maintenir un dump local, ce qui ramène le problème de volume que l'ingestion paresseuse avait supprimé. Ce n'est pas un ajustement de U3, c'est un changement d'architecture, et il faut le traiter comme tel avant de s'y engager.
