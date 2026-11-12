import React from "react";
import styles from './DataTimestamp.scss';

const DataTimestamp: React.FC = () => {
	return (
		<div className={styles.timestamp}>
			Live data from Overpass API
		</div>
	);
};

export default React.memo(DataTimestamp);
