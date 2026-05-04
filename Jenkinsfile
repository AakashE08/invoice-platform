pipeline {
    agent any

    environment {
        DOCKER_HUB_USERNAME = 'aakash888'
        IMAGE_NAME          = "${DOCKER_HUB_USERNAME}/invoice-platform"
        IMAGE_TAG           = "${BUILD_NUMBER}"
        FULL_IMAGE          = "${IMAGE_NAME}:${IMAGE_TAG}"
        KUBECONFIG          = '/var/lib/jenkins/.kube/config'
    }

    stages {

        stage('Checkout') {
            steps {
                echo "Build #${BUILD_NUMBER}"
                git branch: 'main',
                    url: 'https://github.com/AakashE08/invoice-platform.git'
                echo "Commit: ${GIT_COMMIT}"
            }
        }

        stage('Test') {
            steps {
                echo 'Running tests...'
                sh 'npm test'
            }
        }

        stage('Build Docker Image') {
            steps {
                echo "Building: ${FULL_IMAGE}"
                sh "docker build -t ${FULL_IMAGE} ."
                sh "docker tag ${FULL_IMAGE} ${IMAGE_NAME}:latest"
                echo 'Image built successfully'
            }
        }

        stage('Push to Docker Hub') {
            steps {
                withCredentials([usernamePassword(
                    credentialsId: 'dockerhub-credentials',
                    usernameVariable: 'DOCKER_USER',
                    passwordVariable: 'DOCKER_PASS'
                )]) {
                    sh 'docker login -u $DOCKER_USER -p $DOCKER_PASS'
                    sh "docker push ${FULL_IMAGE}"
                    sh "docker push ${IMAGE_NAME}:latest"
                    sh 'docker logout'
                }
            }
        }

        stage('Deploy to Kubernetes') {
            steps {
                sh """
                    kubectl apply -f k8s/deployment.yaml --kubeconfig=${KUBECONFIG}
                    kubectl apply -f k8s/service.yaml   --kubeconfig=${KUBECONFIG}

                    kubectl set image deployment/invoice-platform \
                        invoice-platform=${FULL_IMAGE} \
                        --kubeconfig=${KUBECONFIG}

                    kubectl rollout status deployment/invoice-platform \
                        --timeout=300s \
                        --kubeconfig=${KUBECONFIG}
                """
            }
        }

        stage('Verify') {
            steps {
                sh """
                    echo '=== Pods ==='
                    kubectl get pods -l app=invoice-platform --kubeconfig=${KUBECONFIG}

                    echo '=== Service ==='
                    kubectl get svc invoice-platform-service --kubeconfig=${KUBECONFIG}

                    echo '=== Recent Events ==='
                    kubectl get events --sort-by=.lastTimestamp \
                        --kubeconfig=${KUBECONFIG} | tail -10
                """
            }
        }
    }

    post {
        success {
            echo "Pipeline succeeded!"
            echo "App live at: http://<K8s-Worker-IP>:30080/login"
        }
        failure {
            echo 'Pipeline failed — rolling back...'
            sh "kubectl rollout undo deployment/invoice-platform --kubeconfig=${KUBECONFIG} || true"
        }
        always {
            sh "docker rmi ${FULL_IMAGE} || true"
            cleanWs()
        }
    }
}
