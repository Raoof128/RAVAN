-- Reader shelf status and worker restart checkpoints use only this generation's blocks.
CREATE INDEX cache_blocks_source_generation ON cache_blocks(source_id, generation, state);
