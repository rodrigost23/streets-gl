import React from "react";
import Panel from "~/app/ui/components/Panel";
import styles from './LegalAttributionPanel.scss';

const LegalAttribution: React.FC = () => {
	return <Panel className={styles.attributionPanel}>
		© <a href={'https://www.openstreetmap.org/copyright'} target={'_blank'}>OpenStreetMap</a>
		{' '}
		© <a href={'https://openfreemap.org'} target={'_blank'}>OpenFreeMap</a>
		{' '}
		© <a href={'https://www.openmaptiles.org/'} target={'_blank'}>OpenMapTiles</a>
		{' '}
		© <span>Powered by Esri</span>
	</Panel>
}

export default React.memo(LegalAttribution);