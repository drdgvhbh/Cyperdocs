import { AppState } from '@/store';
import { connect } from 'react-redux';
import HomePage from './HomePage';

const mapStateToProps = (state: AppState) => ({});

const mapDispatchToProps = {};

export default connect(
  mapStateToProps,
  mapDispatchToProps,
)(HomePage);
