-- スキーマは枝（ノードの schema 属性）に移した。サイト側の列は使わない。
ALTER TABLE `sites` DROP COLUMN `schema`;
